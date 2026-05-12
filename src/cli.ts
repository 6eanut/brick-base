#!/usr/bin/env node

/**
 * Brick CLI entry point.
 *
 * Initializes all subsystems and starts the interactive session.
 * Usage: brick [options]
 */

import { createInterface } from 'node:readline';
import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';

import { ConfigManager } from './config/config.js';
import { LLMProvider, type Provider } from './llm/provider.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { GoogleProvider } from './llm/google.js';
import { detectProvider, isAnthropicProvider } from './llm/detect.js';
import { ToolRegistry } from './tools/registry.js';
import { FileTool, setAllowedRoots, setBlockedPaths } from './tools/file.js';
import { createShellTool } from './tools/shell.js';
import { createGitTools } from './tools/git.js';
import { AgentLoop, AgentMode } from './agent/loop.js';
import { CommandRegistry } from './commands/registry.js';
import { ExtensionRegistry } from './extensions/registry.js';
import { ExtensionConfigManager } from './extensions/config.js';
import { BRICK_VERSION, checkExtensionCompatibility } from './extensions/compatibility.js';
import { checkExtensionDependencies } from './extensions/dependencies.js';
import { McpBridge } from './extensions/mcp-bridge.js';
import { ToolAnalytics } from './tools/analytics.js';
import { ProgressRenderer } from './tui/progress.js';
import { printBanner, printWarningBanner, type BannerConfig } from './tui/banner.js';
import { theme } from './tui/theme.js';
import { formatHelp, formatTools, formatExtensions, formatStats, formatError, formatSuccess, formatWarning, formatInfo } from './tui/format.js';
import { updateStatusBar, type StatusBarState } from './tui/status-bar.js';
import { pagerThrough } from './tui/pager.js';

/**
 * Scan the extensions directory and return a Set of installed extension names.
 */
function getInstalledExtensionNames(extParent: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(extParent)) return names;
  try {
    const entries = require('node:fs').readdirSync(extParent, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        names.add(entry.name);
      }
    }
  } catch {
    // Ignore unreadable directories
  }
  return names;
}

// ─── CLI setup ──────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('brick')
  .description('Brick — a modular AI coding agent')
  .version(`Brick v${BRICK_VERSION}`)
  .option('-m, --model <name>', 'LLM model to use')
  .option('-p, --provider <name>', 'LLM provider to use')
  .option('--plan', 'Start in plan mode')
  .option('--api-key <key>', 'API key for the LLM provider')
  .option('--base-url <url>', 'Base URL for the LLM API')
  .option('--no-extensions', 'Disable extension auto-loading')
  .action(main);

program
  .command('init')
  .description('Initialize Brick in the current directory')
  .action(async () => {
    console.log(chalk.green('\n✨ Initialized Brick in this directory.'));
    console.log('  Use environment variables (BRICK_API_KEY, BRICK_PROVIDER) to configure.');
    console.log('  Run `brick` to start the interactive session.\n');
  });

program
  .command('install <path>')
  .description('Install an extension from a local path or npm package')
  .action(async (extPath: string) => {
    const extParent = join(homedir(), '.brick', 'extensions');

    if (!existsSync(extParent)) {
      await mkdir(extParent, { recursive: true });
    }

    // Try local path first
    const srcDir = resolve(extPath);
    const localManifestPath = join(srcDir, 'brick.json');

    if (existsSync(localManifestPath)) {
      // ── Local path install ──────────────────────────────────────────
      let manifest: { name: string; brickVersion?: string };
      try {
        const content = await readFile(localManifestPath, 'utf-8');
        manifest = JSON.parse(content);
      } catch {
        console.log(chalk.red(`\n❌ Invalid brick.json at ${srcDir}\n`));
        process.exit(1);
      }

      // Check Brick version compatibility (non-blocking warning)
      const compatResult = checkExtensionCompatibility(manifest.brickVersion, manifest.name);
      if (!compatResult.compatible && compatResult.message) {
        console.log(chalk.yellow(`  ⚠  ${compatResult.message}`));
      }

      // Check extension dependencies (non-blocking warning)
      const installedNames = getInstalledExtensionNames(extParent);
      const depResult = checkExtensionDependencies(manifest, installedNames);
      if (!depResult.satisfied) {
        for (const dep of depResult.missing) {
          console.log(chalk.yellow(`  ⚠  Extension "${manifest.name}" requires "${dep}" — not installed`));
        }
      }

      const extDir = join(extParent, manifest.name);
      console.log(chalk.cyan(`\n📦 Installing "${manifest.name}" extension...`));

      if (existsSync(extDir)) {
        console.log(chalk.yellow(`  ⚠  Extension "${manifest.name}" already exists, overwriting...`));
        await rm(extDir, { recursive: true, force: true });
      }

      await cp(srcDir, extDir, { recursive: true });
      console.log(chalk.green(`  ✅ Copied to ${extDir}`));

      // Install npm dependencies if package.json exists
      const pkgPath = join(extDir, 'package.json');
      if (existsSync(pkgPath)) {
        console.log(chalk.cyan('  📥 Installing dependencies...'));
        try {
          execSync('npm install --production', { cwd: extDir, stdio: 'pipe', timeout: 60_000 });
          console.log(chalk.green('  ✅ Dependencies installed'));
        } catch {
          console.log(chalk.yellow('  ⚠  npm install failed (will retry on first use)'));
        }
      }

      console.log(chalk.green(`\n✅ Extension "${manifest.name}" installed successfully!`));
      console.log(chalk.gray(`   Run "brick" to start with the extension loaded.\n`));
      return;
    }

    // ── npm package install ────────────────────────────────────────────
    // Verify the package exists on npm
    try {
      execSync(`npm view ${JSON.stringify(extPath)} version`, { stdio: 'pipe', timeout: 15_000 });
    } catch {
      console.log(chalk.red(`\n❌ No brick.json found at "${extPath}" and npm package "${extPath}" not found.\n`));
      process.exit(1);
    }

    console.log(chalk.cyan(`\n📦 Installing "${extPath}" from npm...`));

    // Create a temp directory for the package and install it
    const tempDir = join(extParent, `.tmp-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    try {
      execSync(`npm install ${JSON.stringify(extPath)}`, { cwd: tempDir, stdio: 'pipe', timeout: 120_000 });

      // Find brick.json in the installed package
      const pkgDir = join(tempDir, 'node_modules', extPath);
      const npmManifestPath = join(pkgDir, 'brick.json');

      if (!existsSync(npmManifestPath)) {
        console.log(chalk.yellow(`  ⚠  Package "${extPath}" does not contain a brick.json manifest.`));
        await rm(tempDir, { recursive: true, force: true });
        console.log(chalk.gray(`  Install as a regular npm dependency if it's a library.\n`));
        process.exit(1);
      }

      const npmManifestRaw = await readFile(npmManifestPath, 'utf-8');
      const npmManifest = JSON.parse(npmManifestRaw) as { name: string; brickVersion?: string };

      // Check Brick version compatibility (non-blocking warning)
      const npmCompatResult = checkExtensionCompatibility(npmManifest.brickVersion, npmManifest.name);
      if (!npmCompatResult.compatible && npmCompatResult.message) {
        console.log(chalk.yellow(`  ⚠  ${npmCompatResult.message}`));
      }

      // Check extension dependencies (non-blocking warning)
      const npmInstalledNames = getInstalledExtensionNames(extParent);
      const npmDepResult = checkExtensionDependencies(npmManifest, npmInstalledNames);
      if (!npmDepResult.satisfied) {
        for (const dep of npmDepResult.missing) {
          console.log(chalk.yellow(`  ⚠  Extension "${npmManifest.name}" requires "${dep}" — not installed`));
        }
      }

      const extDir = join(extParent, npmManifest.name);

      if (existsSync(extDir)) {
        console.log(chalk.yellow(`  ⚠  Extension "${npmManifest.name}" already exists, overwriting...`));
        await rm(extDir, { recursive: true, force: true });
      }

      // Copy from node_modules to extensions directory
      await mkdir(extDir, { recursive: true });
      await cp(pkgDir, extDir, { recursive: true });
      await rm(tempDir, { recursive: true, force: true });

      console.log(chalk.green(`  ✅ Installed to ${extDir}`));
      console.log(chalk.green(`\n✅ Extension "${npmManifest.name}" installed successfully!`));
      console.log(chalk.gray(`   Run "brick" to start with the extension loaded.\n`));
    } catch (err) {
      // Clean up temp dir on failure
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
      console.log(chalk.red(`\n❌ Failed to install "${extPath}": ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List installed extensions')
  .action(async () => {
    const extDir = join(homedir(), '.brick', 'extensions');
    if (!existsSync(extDir)) {
      console.log(chalk.yellow('\nNo extensions installed.\n'));
      return;
    }
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(extDir, { withFileTypes: true });
    const extNames = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

    if (extNames.length === 0) {
      console.log(chalk.yellow('\nNo extensions installed.\n'));
      return;
    }

    console.log(chalk.bold('\nInstalled Extensions:\n'));

    // Collect all manifests for cross-dependency checking
    const allManifests: Array<{ name: string; requires?: string[] }> = [];

    for (const name of extNames) {
      const manifestPath = join(extDir, name, 'brick.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const content = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content) as { name: string; version: string; description?: string; brickVersion?: string; requires?: string[]; config?: Record<string, unknown> };

        allManifests.push(manifest);

        // Check compatibility
        const compatResult = checkExtensionCompatibility(manifest.brickVersion, manifest.name);
        const compatFlag = compatResult.compatible ? '' : chalk.yellow(' ⚠');
        const configTag = manifest.config && Object.keys(manifest.config).length > 0 ? chalk.gray(' (configurable)') : '';

        console.log(`  ${chalk.cyan(manifest.name)} v${manifest.version}${compatFlag}${configTag}`);
        if (manifest.description) {
          console.log(`    ${chalk.gray(manifest.description)}`);
        }
        console.log();
      } catch {
        // Skip invalid manifests
      }
    }

    // Show dependency warnings for manifests with missing dependencies
    const installedSet = new Set(allManifests.map(m => m.name));
    for (const m of allManifests) {
      if (!m.requires) continue;
      const missing = m.requires.filter(d => d !== m.name && !installedSet.has(d));
      if (missing.length > 0) {
        console.log(`    ${chalk.yellow('⚠ missing deps: ' + missing.join(', '))}`);
      }
    }

    console.log();
  });

program
  .command('uninstall <name>')
  .description('Remove an installed extension')
  .option('-f, --force', 'Skip confirmation')
  .action(async (name: string, opts: { force?: boolean }) => {
    const extDir = join(homedir(), '.brick', 'extensions', name);

    if (!existsSync(extDir)) {
      console.log(chalk.red(`\n❌ Extension "${name}" is not installed.\n`));
      process.exit(1);
    }

    if (!opts.force) {
      console.log(chalk.yellow(`\n⚠  Are you sure you want to uninstall "${name}"? (y/N)`));
      // Read a single line from stdin
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question('  ', resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(chalk.gray('  Uninstall cancelled.\n'));
        return;
      }
    }

    console.log(chalk.cyan(`\n🗑  Removing "${name}" extension...`));
    await rm(extDir, { recursive: true, force: true });
    console.log(chalk.green(`  ✅ Removed ${extDir}`));
    console.log(chalk.green(`\n✅ Extension "${name}" uninstalled successfully!\n`));
  });

program
  .command('update [name]')
  .description('Update installed extensions to latest versions')
  .option('-a, --all', 'Update all extensions')
  .action(async (name: string | undefined, opts: { all?: boolean }) => {
    const extParent = join(homedir(), '.brick', 'extensions');

    if (!existsSync(extParent)) {
      console.log(chalk.yellow('\nNo extensions installed.\n'));
      return;
    }

    const { readdir, readFile } = await import('node:fs/promises');
    const entries = await readdir(extParent, { withFileTypes: true });
    const extNames = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);

    if (extNames.length === 0) {
      console.log(chalk.yellow('\nNo extensions installed.\n'));
      return;
    }

    // Filter to specific extension if name provided
    const targets = name ? extNames.filter(n => n === name) : extNames;
    if (name && targets.length === 0) {
      console.log(chalk.red(`\n❌ Extension "${name}" is not installed.\n`));
      process.exit(1);
    }

    let updated = 0;
    let skipped = 0;

    for (const extName of targets) {
      const manifestPath = join(extParent, extName, 'brick.json');
      if (!existsSync(manifestPath)) {
        console.log(chalk.yellow(`  ⚠  ${extName}: No brick.json found, skipping.`));
        skipped++;
        continue;
      }

      let manifest: { name: string; version: string; package?: string };
      try {
        const content = await readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(content);
      } catch {
        console.log(chalk.yellow(`  ⚠  ${extName}: Invalid brick.json, skipping.`));
        skipped++;
        continue;
      }

      const pkgName = manifest.package ?? manifest.name;
      const currentVersion = manifest.version;

      // Check npm for latest version
      let latestVersion: string;
      try {
        latestVersion = execSync(
          `npm view ${JSON.stringify(pkgName)} version`,
          { stdio: 'pipe', timeout: 15_000, encoding: 'utf-8' },
        ).toString().trim();
      } catch {
        console.log(chalk.yellow(`  ⚠  ${extName}: Cannot check npm for "${pkgName}", skipping.`));
        skipped++;
        continue;
      }

      if (currentVersion === latestVersion) {
        console.log(chalk.gray(`  ${extName}: ${currentVersion} (latest) — up to date`));
        skipped++;
        continue;
      }

      // Update: re-install from npm
      console.log(chalk.cyan(`  ${extName}: ${currentVersion} → ${latestVersion} (updating...)`));

      const tempDir = join(extParent, `.tmp-update-${Date.now()}`);
      await mkdir(tempDir, { recursive: true });

      try {
        execSync(`npm install ${JSON.stringify(pkgName)}`, {
          cwd: tempDir, stdio: 'pipe', timeout: 120_000,
        });

        const pkgDir = join(tempDir, 'node_modules', pkgName);
        const newManifestPath = join(pkgDir, 'brick.json');

        if (!existsSync(newManifestPath)) {
          throw new Error('Updated package has no brick.json');
        }

        // Check compatibility of the new version
        const newManifestRaw = await readFile(newManifestPath, 'utf-8');
        const newManifest = JSON.parse(newManifestRaw) as { brickVersion?: string; requires?: string[] };
        const updateCompatResult = checkExtensionCompatibility(newManifest.brickVersion, extName);
        if (!updateCompatResult.compatible && updateCompatResult.message) {
          console.log(chalk.yellow(`  ⚠  ${updateCompatResult.message}`));
        }

        // Check dependencies of the new version
        const updateInstalledNames = getInstalledExtensionNames(extParent);
        const updateDepResult = checkExtensionDependencies(
          { name: extName, requires: newManifest.requires },
          updateInstalledNames,
        );
        if (!updateDepResult.satisfied) {
          for (const dep of updateDepResult.missing) {
            console.log(chalk.yellow(`  ⚠  Extension "${extName}" requires "${dep}" — not installed`));
          }
        }

        // Remove old extension dir
        const extDir = join(extParent, extName);
        await rm(extDir, { recursive: true, force: true });

        // Copy new version
        await mkdir(extDir, { recursive: true });
        await cp(pkgDir, extDir, { recursive: true });

        await rm(tempDir, { recursive: true, force: true });

        console.log(chalk.green(`    ✅ Updated to ${latestVersion}`));
        updated++;
      } catch (err) {
        if (existsSync(tempDir)) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
        console.log(chalk.red(`    ❌ Update failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    console.log();
    if (updated > 0) {
      console.log(chalk.green(`✅ Updated ${updated} extension(s).`));
    }
    if (skipped > 0) {
      console.log(chalk.gray(`   ${skipped} extension(s) skipped (up to date or unavailable).`));
    }
    if (updated === 0 && skipped === 0) {
      console.log(chalk.yellow('   No extensions to update.'));
    }
    console.log();
  });

/**
 * Load the extension state map from ~/.brick/extensions-state.json.
 * Returns an empty map if the file doesn't exist or is invalid.
 */
function loadExtensionState(): Map<string, boolean> {
  const stateFile = join(homedir(), '.brick', 'extensions-state.json');
  const map = new Map<string, boolean>();
  if (!existsSync(stateFile)) return map;
  try {
    const content = require('node:fs').readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, boolean>;
    for (const [name, enabled] of Object.entries(parsed)) {
      map.set(name, enabled);
    }
  } catch {
    // Ignore invalid state files
  }
  return map;
}

/**
 * Save the extension state map to ~/.brick/extensions-state.json.
 */
function saveExtensionState(state: Map<string, boolean>): void {
  const stateFile = join(homedir(), '.brick', 'extensions-state.json');
  const obj: Record<string, boolean> = {};
  for (const [name, enabled] of state) {
    obj[name] = enabled;
  }
  require('node:fs').writeFileSync(stateFile, JSON.stringify(obj, null, 2), 'utf-8');
}

program
  .command('enable <name>')
  .description('Enable a disabled extension')
  .action(async (name: string) => {
    const extDir = join(homedir(), '.brick', 'extensions', name);
    if (!existsSync(extDir)) {
      console.log(chalk.red(`\n❌ Extension "${name}" is not installed.\n`));
      process.exit(1);
    }

    const state = loadExtensionState();
    state.set(name, true);
    saveExtensionState(state);
    console.log(chalk.green(`\n✅ Extension "${name}" enabled.\n`));
  });

program
  .command('disable <name>')
  .description('Disable an installed extension')
  .action(async (name: string) => {
    const extDir = join(homedir(), '.brick', 'extensions', name);
    if (!existsSync(extDir)) {
      console.log(chalk.red(`\n❌ Extension "${name}" is not installed.\n`));
      process.exit(1);
    }

    const state = loadExtensionState();
    state.set(name, false);
    saveExtensionState(state);
    console.log(chalk.yellow(`\n✅ Extension "${name}" disabled (use "brick enable ${name}" to re-enable).\n`));
  });

/**
 * Load the extension config map from ~/.brick/extensions-config.json.
 */
function loadExtensionConfigs(): Map<string, Record<string, unknown>> {
  const configFile = join(homedir(), '.brick', 'extensions-config.json');
  const map = new Map<string, Record<string, unknown>>();
  if (!existsSync(configFile)) return map;
  try {
    const content = require('node:fs').readFileSync(configFile, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>;
    for (const [name, cfg] of Object.entries(parsed)) {
      map.set(name, cfg);
    }
  } catch {
    // Ignore invalid config files
  }
  return map;
}

/**
 * Save the extension config map to ~/.brick/extensions-config.json.
 */
function saveExtensionConfigs(configs: Map<string, Record<string, unknown>>): void {
  const configFile = join(homedir(), '.brick', 'extensions-config.json');
  const obj: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of configs) {
    obj[name] = cfg;
  }
  require('node:fs').writeFileSync(configFile, JSON.stringify(obj, null, 2), 'utf-8');
}

/**
 * Coerce a string value to a target type for extension config.
 */
function coerceConfigValue(value: string, type: string): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    case 'boolean':
      return value === 'true' || value === '1' || value === 'yes';
    case 'select':
    case 'string':
    default:
      return value;
  }
}

program
  .command('config <extension> [key] [value]')
  .description('View or set extension configuration')
  .action(async (extension: string, key?: string, value?: string) => {
    const extDir = join(homedir(), '.brick', 'extensions', extension);
    const manifestPath = join(extDir, 'brick.json');

    if (!existsSync(extDir) || !existsSync(manifestPath)) {
      console.log(chalk.red(`\n❌ Extension "${extension}" is not installed.\n`));
      process.exit(1);
    }

    // Read manifest for config schema
    let manifest: { config?: Record<string, any> };
    try {
      manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf-8'));
    } catch {
      console.log(chalk.red(`\n❌ Invalid brick.json for "${extension}".\n`));
      process.exit(1);
    }

    const schema = manifest.config;
    if (!schema || Object.keys(schema).length === 0) {
      console.log(chalk.yellow(`\n  Extension "${extension}" has no configurable settings.\n`));
      return;
    }

    // Load user overrides
    const allConfigs = loadExtensionConfigs();
    const userOverrides = allConfigs.get(extension) ?? {};

    // Mode: set config key
    if (key !== undefined && value !== undefined) {
      const entry = schema[key];
      if (!entry) {
        console.log(chalk.red(`\n  Unknown config key "${key}". Available: ${Object.keys(schema).join(', ')}\n`));
        process.exit(1);
      }

      const coerced = coerceConfigValue(value, entry.type);
      if (entry.type === 'select' && entry.options && !entry.options.includes(String(coerced))) {
        console.log(chalk.red(`\n  Invalid value for "${key}". Allowed: ${entry.options.join(', ')}\n`));
        process.exit(1);
      }

      userOverrides[key] = coerced;
      allConfigs.set(extension, userOverrides);
      saveExtensionConfigs(allConfigs);
      console.log(chalk.green(`\n✅ ${extension}: ${key} set to ${JSON.stringify(coerced)}\n`));
      return;
    }

    // Mode: show single key
    if (key !== undefined) {
      const entry = schema[key];
      if (!entry) {
        console.log(chalk.red(`\n  Unknown config key "${key}". Available: ${Object.keys(schema).join(', ')}\n`));
        process.exit(1);
      }

      const effective = userOverrides[key] ?? entry.default ?? null;
      const isOverridden = key in userOverrides;
      const label = entry.label ?? key;
      console.log(chalk.bold(`\n${label}`));
      console.log(`  ${chalk.gray(entry.description)}`);
      console.log(`  type: ${entry.type}`);
      if (entry.options) console.log(`  options: ${entry.options.join(', ')}`);
      console.log(`  default: ${JSON.stringify(entry.default)}`);
      console.log(`  current: ${isOverridden ? chalk.green(JSON.stringify(effective)) : JSON.stringify(effective)}`);
      console.log();
      return;
    }

    // Mode: show all config
    console.log(chalk.bold(`\nConfiguration for "${extension}":\n`));
    for (const [k, entry] of Object.entries(schema)) {
      const effective = userOverrides[k] ?? entry.default ?? null;
      const isOverridden = k in userOverrides;
      const label = entry.label ?? k;
      const formattedValue = effective === null ? '(not set)' : JSON.stringify(effective);

      let typeTag: string;
      if (entry.type === 'select') {
        typeTag = `[${entry.options?.join('|')}]`;
      } else {
        typeTag = entry.type;
      }

      const marker = isOverridden ? chalk.green('*') : ' ';
      const val = isOverridden ? chalk.green(formattedValue) : formattedValue;
      console.log(`  ${marker} ${chalk.cyan(label)} (${typeTag}) = ${val}`);
      console.log(`    ${chalk.gray(entry.description)}`);
      if (entry.default !== undefined) {
        console.log(`    default: ${JSON.stringify(entry.default)}`);
      }
      console.log();
    }
    console.log(chalk.gray('  * = overridden from default\n'));
  });

async function main(): Promise<void> {
  const opts = program.opts();

  // ─── Config ──────────────────────────────────────────────────────────
  const config = new ConfigManager({
    defaultProvider: opts.provider ?? undefined,
  });
  config.loadFromEnv();

  // ─── LLM Provider ───────────────────────────────────────────────────
  const providedProvider = opts.provider || config.get('defaultProvider');
  const modelFromOpts = opts.model ?? undefined;

  // Auto-detect provider if not explicitly set
  const detectedProvider = providedProvider && providedProvider !== 'auto'
    ? providedProvider
    : detectProvider({
        apiKey: opts.apiKey
          ?? process.env.ANTHROPIC_API_KEY
          ?? process.env.GOOGLE_API_KEY
          ?? process.env.DEEPSEEK_API_KEY
          ?? process.env.BRICK_API_KEY
          ?? undefined,
        model: modelFromOpts,
        baseUrl: opts.baseUrl ?? undefined,
        explicit: providedProvider === 'auto' ? undefined : providedProvider,
      }) ?? 'openai';

  const providerName = detectedProvider;
  const providerCfg = config.getProviderConfig(providerName);
  const provider: Provider = isAnthropicProvider(providerName)
    ? new AnthropicProvider({
        name: providerName,
        apiKey: opts.apiKey ?? providerCfg.apiKey,
        baseUrl: opts.baseUrl ?? providerCfg.baseUrl,
        defaultModel: opts.model ?? providerCfg.defaultModel ?? undefined,
      })
    : providerName === 'google'
      ? new GoogleProvider({
          name: providerName,
          apiKey: opts.apiKey ?? providerCfg.apiKey,
          baseUrl: opts.baseUrl ?? providerCfg.baseUrl,
          defaultModel: opts.model ?? providerCfg.defaultModel ?? undefined,
        })
      : new LLMProvider({
        name: providerName,
        apiKey: opts.apiKey ?? providerCfg.apiKey,
        baseUrl: opts.baseUrl ?? providerCfg.baseUrl,
        defaultModel: opts.model ?? providerCfg.defaultModel ?? undefined,
      });

  const hasApiKey = !!(
    providerCfg.apiKey ||
    opts.apiKey ||
    process.env.BRICK_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.DEEPSEEK_API_KEY
  ) || providerName === 'ollama'; // Ollama is local, no key needed

  if (!hasApiKey) {
    printWarningBanner('No API key configured. Set BRICK_API_KEY or pass --api-key. Starting in plan mode (no LLM calls).');
  }

  // ─── Tools ───────────────────────────────────────────────────────────
  const toolRegistry = new ToolRegistry();

  FileTool.registerAll(toolRegistry);

  setAllowedRoots([
    process.cwd(),
    ...(config.get('shell').allowedDirectories || []),
    ...(config.get('file').allowedRoots || []),
  ]);
  setBlockedPaths(config.get('file').blockedPaths || []);

  const shellTool = createShellTool(config.get('shell'));
  toolRegistry.register(shellTool);

  const gitTools = createGitTools();
  for (const tool of gitTools) {
    toolRegistry.register(tool);
  }

  // ─── Extensions ──────────────────────────────────────────────────────
  const extensionRegistry = new ExtensionRegistry(config.get('extensionPaths'));
  const configManager = new ExtensionConfigManager(() => extensionRegistry);
  const mcpBridge = new McpBridge();

  if (opts.extensions !== false) {
    const discovered = await extensionRegistry.discover();

    if (discovered.length > 0) {
      const extResults: string[] = [];
      let loadedCount = 0;

      for (const ext of extensionRegistry.listEnabled()) {
        try {
          const cfgEnv = configManager.getConfigAsEnv(ext.manifest.name);
          const extTools = await mcpBridge.connect(ext, cfgEnv);
          for (const tool of extTools) {
            toolRegistry.register(tool, `extension:${ext.manifest.name}`);
          }
          const compatResult = checkExtensionCompatibility(ext.manifest.brickVersion, ext.manifest.name);
          const compatSuffix = compatResult.compatible ? '' : theme.warning(' (incompatible Brick version)');
          extResults.push(`  ${theme.success('✓')} ${ext.manifest.name} v${ext.manifest.version}${compatSuffix}`);
          loadedCount++;
        } catch (err) {
          extResults.push(`  ${theme.error('✖')} ${ext.manifest.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (process.stdout.isTTY) {
        console.log(formatInfo(
          `Extensions (${loadedCount}/${discovered.length})`,
          extResults.join('\n'),
        ));
      } else {
        // Non-TTY: silent load, no ANSI visual output
        for (const ext of extensionRegistry.listEnabled()) {
          try {
            const cfgEnv = configManager.getConfigAsEnv(ext.manifest.name);
            for (const tool of await mcpBridge.connect(ext, cfgEnv)) {
              toolRegistry.register(tool, `extension:${ext.manifest.name}`);
            }
          } catch {
            // Silently skip failures in non-TTY mode
          }
        }
      }
    }
  }

  // ─── Agent Loop ──────────────────────────────────────────────────────
  const agent = new AgentLoop(provider, toolRegistry, {
    config: {
      mode: opts.plan ? AgentMode.PLAN : AgentMode.BUILD,
      model: opts.model ?? undefined,
    },
  });

  // ─── Progress Visualization ──────────────────────────────────────────
  const progress = new ProgressRenderer();
  agent.on('llm_request', (data) => progress.showThinking(data));
  agent.on('llm_token', (data) => progress.showToken(data));
  agent.on('llm_response', (data) => progress.showLLMResponse(data));
  agent.on('tool_call', (data) => progress.showToolCall(data));
  agent.on('tool_result', (data) => progress.showToolResult(data));
  agent.on('turn_end', (data) => progress.showTurnEnd(data));
  agent.on('final_response', () => progress.finish());
  agent.on('context_warning', (data) => progress.showContextWarning(data));
  agent.on('error', (data) => progress.showError(data));

  // ─── Tool Analytics ──────────────────────────────────────────────────
  const analytics = new ToolAnalytics();
  agent.on('tool_result', (data) => {
    analytics.recordCall(data.name, data.durationMs, data.success);
  });

  // ─── Commands ────────────────────────────────────────────────────────
  const cmdRegistry = new CommandRegistry();
  let shouldExit = false;

  // Track current mode for status bar and dynamic prompt
  let currentMode = agent.getMode();

  cmdRegistry.registerBuiltins({
    mode: agent.getMode(),
    setMode: (mode) => {
      agent.setMode(mode as AgentMode);
      currentMode = mode as AgentMode;
      rl.setPrompt(`brick [${currentMode}] > `);
      updateStatusBar({
        mode: currentMode,
        model: opts.model ?? providerCfg.defaultModel ?? 'auto',
        provider: providerName,
        toolCount: toolRegistry.listAll().length,
      });
    },
    setModel: (model) => {
      agent.setModel(model);
      updateStatusBar({
        mode: currentMode,
        model,
        provider: providerName,
        toolCount: toolRegistry.listAll().length,
      });
    },
    clearConversation: () => agent.getConversation().clear(),
    listTools: () => {
      const tools = toolRegistry.listAll();
      if (tools.length === 0) return 'No tools registered.';
      return formatTools(tools.map(t => ({
        name: t.name,
        description: t.description,
        source: toolRegistry.getSource(t.name),
      })));
    },
    listExtensions: () => {
      const exts = extensionRegistry.listAll();
      return formatExtensions(exts.map(e => ({
        name: e.manifest.name,
        version: e.manifest.version,
        description: e.manifest.description,
        enabled: e.enabled,
        configurable: e.manifest.config ? Object.keys(e.manifest.config).length > 0 : false,
      })));
    },
    enableExtension: (name: string) => {
      const ext = extensionRegistry.get(name);
      if (!ext) return `Extension "${name}" is not installed.`;
      if (ext.enabled) return `Extension "${name}" is already enabled.`;
      extensionRegistry.setEnabled(name, true);
      return formatSuccess(`Extension "${name}" enabled.`);
    },
    disableExtension: (name: string) => {
      const ext = extensionRegistry.get(name);
      if (!ext) return `Extension "${name}" is not installed.`;
      if (!ext.enabled) return `Extension "${name}" is already disabled.`;
      extensionRegistry.setEnabled(name, false);
      return formatSuccess(`Extension "${name}" disabled. Use "brick enable ${name}" to re-enable.`);
    },
    getExtensionConfig: (name: string) => {
      // Support "<ext> <key>" format for single-key lookup
      const parts = name.split(' ');
      const extName = parts[0];
      const keyName = parts[1];

      const ext = extensionRegistry.get(extName);
      if (!ext) return `Extension "${extName}" is not installed.`;

      if (keyName) {
        const schema = ext.manifest.config?.[keyName];
        if (!schema) return `Unknown config key "${keyName}".`;
        const config = configManager.getConfig(extName);
        const effective = config[keyName] ?? schema.default ?? null;
        let result = `${schema.label ?? keyName}: ${JSON.stringify(effective)}`;
        result += `\n  ${schema.description}`;
        result += `\n  type: ${schema.type}`;
        result += `\n  default: ${JSON.stringify(schema.default)}`;
        return result;
      }

      return configManager.formatConfig(extName);
    },
    setExtensionConfig: (name: string, key: string, value: string) => {
      const ext = extensionRegistry.get(name);
      if (!ext) return `Extension "${name}" is not installed.`;
      const result = configManager.setConfig(name, key, value);
      return formatSuccess(result);
    },
    getStats: () => {
      const summary = analytics.getSummary();
      return formatStats(summary);
    },
    exit: () => { shouldExit = true; },
  });

  // Override /help with boxen-formatted output
  cmdRegistry.register({
    name: 'help',
    description: 'Show available commands',
    execute: async () => {
      const cmds = cmdRegistry.listAll();
      return formatHelp(cmds.map(c => ({
        name: `/${c.name}${c.usage ? ' ' + c.usage : ''}`,
        description: c.description,
      })));
    },
  });

  // ─── Image command ────────────────────────────────────────────────
  cmdRegistry.register({
    name: 'image',
    description: 'Attach an image file to the conversation',
    usage: '<path>',
    execute: async (args) => {
      if (!args[0]) {
        return 'Usage: /image <path-to-image>';
      }
      const imgPath = resolve(args[0]);
      if (!existsSync(imgPath)) {
        return `File not found: ${imgPath}`;
      }
      // Read file and detect MIME type from extension
      const ext = imgPath.toLowerCase().split('.').pop() ?? '';
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
      };
      const mediaType = mimeMap[ext];
      if (!mediaType) {
        return `Unsupported image format: .${ext}. Supported: png, jpg, jpeg, gif, webp, bmp`;
      }
      const data = await readFile(imgPath, { encoding: 'base64' });
      agent.getConversation().addUserMessage('', [{ data, mediaType }]);
      return `Image attached: ${imgPath} (${mediaType})`;
    },
  });

  // ─── Print banner ────────────────────────────────────────────────────
  printBanner({
    version: BRICK_VERSION,
    provider: providerName,
    model: opts.model ?? providerCfg.defaultModel ?? 'auto',
    tools: toolRegistry.listAll().length,
    mode: agent.getMode(),
    extensions: extensionRegistry.listAll().length > 0 ? extensionRegistry.listAll().length : undefined,
  });

  // ─── Initial Status Bar ──────────────────────────────────────────────
  updateStatusBar({
    mode: agent.getMode(),
    model: opts.model ?? providerCfg.defaultModel ?? 'auto',
    provider: providerName,
    toolCount: toolRegistry.listAll().length,
  });

  // ─── REPL ────────────────────────────────────────────────────────────
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `brick [${agent.getMode()}] > `,
    historySize: 100,
    completer: (line: string) => {
      const completions = ['/help', '/clear', '/mode', '/model', '/tools', '/extensions', '/enable', '/disable', '/config', '/stats', '/exit', '/quit', '/image'];
      const hits = completions.filter(c => c.startsWith(line));
      return [hits.length ? hits : completions, line];
    },
  });

  rl.prompt();

  for await (const line of rl) {
    if (shouldExit) break;

    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }

    // Try as command first
    const cmdResult = await cmdRegistry.tryExecute(input, {
      mode: agent.getMode(),
      setMode: (mode) => agent.setMode(mode as AgentMode),
      setModel: (model) => agent.setModel(model),
      clearConversation: () => agent.getConversation().clear(),
      listTools: () => toolRegistry.listAll().map(t => `  ${t.name}`).join('\n'),
      listExtensions: () => extensionRegistry.listAll().map(e => `  ${e.manifest.name}`).join('\n'),
      enableExtension: (name: string) => {
        const ext = extensionRegistry.get(name);
        if (!ext) return `Extension "${name}" is not installed.`;
        if (ext.enabled) return `Extension "${name}" is already enabled.`;
        extensionRegistry.setEnabled(name, true);
        return `Extension "${name}" enabled.`;
      },
      disableExtension: (name: string) => {
        const ext = extensionRegistry.get(name);
        if (!ext) return `Extension "${name}" is not installed.`;
        if (!ext.enabled) return `Extension "${name}" is already disabled.`;
        extensionRegistry.setEnabled(name, false);
        return `Extension "${name}" disabled.`;
      },
      getExtensionConfig: (name: string) => {
        const parts = name.split(' ');
        const extName = parts[0];
        const keyName = parts[1];
        const ext = extensionRegistry.get(extName);
        if (!ext) return `Extension "${extName}" is not installed.`;
        if (keyName) {
          const schema = ext.manifest.config?.[keyName];
          if (!schema) return `Unknown config key "${keyName}".`;
          const config = configManager.getConfig(extName);
          const effective = config[keyName] ?? schema.default ?? null;
          let result = `${schema.label ?? keyName}: ${JSON.stringify(effective)}`;
          result += `\n  ${schema.description}`;
          result += `\n  default: ${JSON.stringify(schema.default)}`;
          return result;
        }
        return configManager.formatConfig(extName);
      },
      setExtensionConfig: (name: string, key: string, value: string) => {
        const ext = extensionRegistry.get(name);
        if (!ext) return `Extension "${name}" is not installed.`;
        return configManager.setConfig(name, key, value);
      },
      getStats: () => analytics.getSummary(),
      exit: () => { shouldExit = true; },
    });

    if (cmdResult !== null) {
      // Auto-wrap plain-text responses into boxen format for consistency.
      // Results already containing boxen borders (╭) pass through as-is.
      if (cmdResult === '') {
        // Empty — skip
      } else if (cmdResult === 'Goodbye!') {
        console.log(`  ${theme.dim('Goodbye!')}`);
      } else if (!cmdResult.includes('╭')) {
        // Plain text — detect type from content
        if (cmdResult.startsWith('Unknown command:') || cmdResult.startsWith('Usage:')) {
          console.log(formatWarning(cmdResult));
        } else if (cmdResult.startsWith('Extension ') && (cmdResult.includes('not installed') || cmdResult.includes('not found'))) {
          console.log(formatWarning(cmdResult));
        } else if (cmdResult.startsWith('File not found') || cmdResult.startsWith('Unsupported')) {
          console.log(formatWarning(cmdResult));
        } else if (cmdResult.includes('already enabled') || cmdResult.includes('already disabled')) {
          console.log(formatInfo(undefined, cmdResult));
        } else if (cmdResult.includes('configurable') || cmdResult.includes('config key')) {
          console.log(formatInfo(undefined, cmdResult));
        } else if (cmdResult === 'Conversation cleared.') {
          console.log(formatSuccess(cmdResult));
        } else if (cmdResult.startsWith('Switched to')) {
          console.log(formatSuccess(cmdResult));
        } else if (cmdResult.startsWith('Model set to')) {
          console.log(formatSuccess(cmdResult));
        } else {
          console.log(formatSuccess(cmdResult));
        }
      } else {
        // Already boxen-formatted
        console.log(cmdResult);
      }

      // Skip prompt+update if exiting
      if (shouldExit) continue;

      // Update status bar after commands that may change mode/model
      updateStatusBar({
        mode: currentMode,
        model: opts.model ?? providerCfg.defaultModel ?? 'auto',
        provider: providerName,
        toolCount: toolRegistry.listAll().length,
      });
      console.log(); // Blank line before next prompt
      rl.prompt();
      continue;
    }

    // Process as agent input
    try {
      // Show status bar before agent run
      updateStatusBar({
        mode: currentMode,
        model: opts.model ?? providerCfg.defaultModel ?? 'auto',
        provider: providerName,
        toolCount: toolRegistry.listAll().length,
      });

      const result = await agent.run(input);

      // Refresh status bar with token count
      updateStatusBar({
        mode: currentMode,
        model: opts.model ?? providerCfg.defaultModel ?? 'auto',
        provider: providerName,
        toolCount: toolRegistry.listAll().length,
        totalTokens: result.totalTokens,
      });

      // Use pager for long responses (non-TTY only — TTY already streamed content)
      if (!process.stdout.isTTY) {
        await pagerThrough(result.response);
      }
    } catch (err) {
      progress.finish();
      const msg = err instanceof Error ? err.message : String(err);
      // Enrich terse error messages with provider context
      const modelName = opts.model ?? providerCfg.defaultModel ?? 'auto';
      const enriched = msg === 'fetch failed'
        ? `Failed to connect to LLM provider "${providerName}" (model: ${modelName}) — check your network, base URL, and API key`
        : msg.includes('LLM API error')
          ? `${msg} (provider: ${providerName}, model: ${modelName})`
          : msg;
      console.log(formatError(enriched));
    }

    if (shouldExit) break;
    rl.prompt();
  }

  // Cleanup
  mcpBridge.disconnectAll();
  rl.close();
}

program.parse(process.argv);
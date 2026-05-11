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
import { McpBridge } from './extensions/mcp-bridge.js';
import { ToolAnalytics } from './tools/analytics.js';
import { ProgressRenderer } from './tui/progress.js';

// ─── CLI setup ──────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('brick')
  .description('Brick — a modular AI coding agent')
  .version('0.1.0')
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
      let manifest: { name: string };
      try {
        const content = await readFile(localManifestPath, 'utf-8');
        manifest = JSON.parse(content);
      } catch {
        console.log(chalk.red(`\n❌ Invalid brick.json at ${srcDir}\n`));
        process.exit(1);
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
      const npmManifest = JSON.parse(npmManifestRaw) as { name: string };

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
    for (const name of extNames) {
      const manifestPath = join(extDir, name, 'brick.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const content = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content) as { name: string; version: string; description?: string };
        console.log(`  ${chalk.cyan(manifest.name)} v${manifest.version}`);
        if (manifest.description) {
          console.log(`    ${chalk.gray(manifest.description)}`);
        }
        console.log();
      } catch {
        // Skip invalid manifests
      }
    }
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
    console.log(chalk.yellow('\n⚠  No API key configured. Set BRICK_API_KEY or pass --api-key.'));
    console.log(chalk.gray('  Starting in plan mode (no LLM calls).\n'));
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
  const mcpBridge = new McpBridge();

  if (opts.extensions !== false) {
    const discovered = await extensionRegistry.discover();
    if (discovered.length > 0) {
      console.log(chalk.cyan(`\n🔌 Loading ${discovered.length} extension(s)...`));

      for (const ext of extensionRegistry.listEnabled()) {
        try {
          const extTools = await mcpBridge.connect(ext);
          for (const tool of extTools) {
            toolRegistry.register(tool, `extension:${ext.manifest.name}`);
          }
          console.log(chalk.green(`  ✅ ${ext.manifest.name} v${ext.manifest.version}`));
        } catch (err) {
          console.log(chalk.red(`  ❌ ${ext.manifest.name}: ${err}`));
        }
      }
      console.log();
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

  cmdRegistry.registerBuiltins({
    mode: agent.getMode(),
    setMode: (mode) => agent.setMode(mode as AgentMode),
    setModel: (model) => agent.setModel(model),
    clearConversation: () => agent.getConversation().clear(),
    listTools: () => {
      const tools = toolRegistry.listAll();
      return tools.length > 0
        ? `Registered tools:\n${tools.map(t => `  ${t.name} — ${t.description}`).join('\n')}`
        : 'No tools registered.';
    },
    listExtensions: () => {
      const exts = extensionRegistry.listAll();
      return exts.length > 0
        ? `Installed extensions:\n${exts.map(e => `  ${e.manifest.name} v${e.manifest.version} — ${e.manifest.description}${e.enabled ? '' : ' (disabled)'}`).join('\n')}`
        : 'No extensions installed.';
    },
    getStats: () => analytics.getSummary(),
    exit: () => { shouldExit = true; },
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
  console.log(chalk.bold('\n🧱 Brick — Modular AI Coding Agent v0.1.0'));
  console.log(chalk.gray(`  Provider: ${providerName}`));
  console.log(chalk.gray(`  Model: ${opts.model ?? providerCfg.defaultModel ?? 'auto'}`));
  console.log(chalk.gray(`  Tools: ${toolRegistry.listAll().length} | Mode: ${agent.getMode()}`));
  if (extensionRegistry.listAll().length > 0) {
    console.log(chalk.gray(`  Extensions: ${extensionRegistry.listAll().length}`));
  }
  console.log(chalk.gray(`  Type /help for commands, /exit to quit\n`));

  // ─── REPL ────────────────────────────────────────────────────────────
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'brick> ',
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
      getStats: () => analytics.getSummary(),
      exit: () => { shouldExit = true; },
    });

    if (cmdResult !== null) {
      console.log(cmdResult);
      rl.prompt();
      continue;
    }

    // Process as agent input
    try {
      const result = await agent.run(input);
      console.log(result.response);

      if (result.toolsCalled) {
        console.log(`  (${result.turns} turn(s), ${result.totalTokens} tokens)`);
      }
    } catch (err) {
      progress.finish();
      console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }

    rl.prompt();
  }

  // Cleanup
  mcpBridge.disconnectAll();
  rl.close();
}

program.parse(process.argv);
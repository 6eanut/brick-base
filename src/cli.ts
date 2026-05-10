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
import { ToolRegistry } from './tools/registry.js';
import { FileTool, setAllowedRoots, setBlockedPaths } from './tools/file.js';
import { createShellTool } from './tools/shell.js';
import { createGitTools } from './tools/git.js';
import { AgentLoop, AgentMode } from './agent/loop.js';
import { CommandRegistry } from './commands/registry.js';
import { ExtensionRegistry } from './extensions/registry.js';
import { McpBridge } from './extensions/mcp-bridge.js';
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
  .description('Install an extension from a local path')
  .action(async (extPath: string) => {
    const srcDir = resolve(extPath);
    const manifestPath = join(srcDir, 'brick.json');

    if (!existsSync(manifestPath)) {
      console.log(chalk.red(`\n❌ No brick.json found at ${srcDir}\n`));
      process.exit(1);
    }

    let manifest: { name: string };
    try {
      const content = await readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(content);
    } catch {
      console.log(chalk.red(`\n❌ Invalid brick.json at ${srcDir}\n`));
      process.exit(1);
    }

    const extDir = join(homedir(), '.brick', 'extensions', manifest.name);
    const extParent = join(homedir(), '.brick', 'extensions');

    console.log(chalk.cyan(`\n📦 Installing "${manifest.name}" extension...`));

    if (!existsSync(extParent)) {
      await mkdir(extParent, { recursive: true });
    }

    if (existsSync(extDir)) {
      console.log(chalk.yellow(`  ⚠  Extension "${manifest.name}" already exists, overwriting...`));
      await rm(extDir, { recursive: true, force: true });
    }

    // Copy extension directory
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
  });

async function main(): Promise<void> {
  const opts = program.opts();

  // ─── Config ──────────────────────────────────────────────────────────
  const config = new ConfigManager({
    defaultProvider: opts.provider ?? undefined,
  });
  config.loadFromEnv();

  // ─── LLM Provider ───────────────────────────────────────────────────
  const providerName = opts.provider || config.get('defaultProvider');
  const providerCfg = config.getProviderConfig(providerName);
  const provider: Provider = providerName === 'anthropic'
    ? new AnthropicProvider({
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
    process.env.ANTHROPIC_API_KEY
  );

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
  agent.on('llm_response', (data) => progress.showLLMResponse(data));
  agent.on('tool_call', (data) => progress.showToolCall(data));
  agent.on('tool_result', (data) => progress.showToolResult(data));
  agent.on('turn_end', (data) => progress.showTurnEnd(data));
  agent.on('final_response', () => progress.finish());
  agent.on('error', (data) => progress.showError(data));

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
    exit: () => { shouldExit = true; },
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
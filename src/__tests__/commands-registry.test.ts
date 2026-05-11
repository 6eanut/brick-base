/**
 * CommandRegistry tests.
 *
 * Covers: register, get, unregister, built-in commands,
 * tryExecute parsing, help output.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CommandRegistry } from '../commands/registry.js';
import type { CommandContext } from '../commands/registry.js';

function createContext(): CommandContext {
  return {
    mode: 'build',
    setMode: () => {},
    setModel: () => {},
    clearConversation: () => {},
    listTools: () => 'tool_a\ntool_b',
    listExtensions: () => 'ext_a',
    getStats: () => 'Tool Usage Stats\n  read_file ─ 5 calls',
    exit: () => {},
  };
}

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it('registers and retrieves a command', () => {
    registry.register({
      name: 'test',
      description: 'A test command',
      execute: async () => 'done',
    });
    expect(registry.get('test')).toBeDefined();
    expect(registry.get('test')?.name).toBe('test');
  });

  it('returns undefined for unknown command', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  it('unregisters a command', () => {
    registry.register({
      name: 'test',
      description: 'A test command',
      execute: async () => 'done',
    });
    expect(registry.unregister('test')).toBe(true);
    expect(registry.get('test')).toBeUndefined();
  });

  it('lists all registered commands', () => {
    registry.register({ name: 'a', description: '', execute: async () => '' });
    registry.register({ name: 'b', description: '', execute: async () => '' });
    expect(registry.listAll()).toHaveLength(2);
  });

  it('tryExecute returns null for non-command input', async () => {
    const result = await registry.tryExecute('just some text', createContext());
    expect(result).toBeNull();
  });

  it('tryExecute parses /command and calls execute', async () => {
    registry.register({
      name: 'greet',
      description: 'Greet someone',
      usage: '<name>',
      execute: async (args) => `Hello ${args[0] ?? 'world'}!`,
    });
    const result = await registry.tryExecute('/greet Alice', createContext());
    expect(result).toBe('Hello Alice!');
  });

  it('tryExecute handles unknown command', async () => {
    const result = await registry.tryExecute('/blargh', createContext());
    expect(result).toContain('Unknown command');
  });

  it('built-in /help lists available commands', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/help', createContext());
    expect(result).toContain('/help');
    expect(result).toContain('/clear');
    expect(result).toContain('/exit');
  });

  it('built-in /clear clears conversation', async () => {
    let cleared = false;
    registry.registerBuiltins(createContext());
    registry.register({
      name: 'clear',
      description: '',
      execute: async () => { cleared = true; return 'Cleared'; },
    });
    await registry.tryExecute('/clear', createContext());
    expect(cleared).toBe(true);
  });

  it('built-in /mode switches agent mode', async () => {
    let currentMode = 'build';
    const ctx = createContext();
    ctx.setMode = (m: string) => { currentMode = m; };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/mode plan', ctx);
    expect(currentMode).toBe('plan');
  });

  it('built-in /mode rejects invalid mode', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/mode invalid', createContext());
    expect(result).toContain('Usage');
  });

  it('built-in /model sets model name', async () => {
    let model = '';
    const ctx = createContext();
    ctx.setModel = (m: string) => { model = m; };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/model claude-sonnet-4', ctx);
    expect(model).toBe('claude-sonnet-4');
  });

  it('built-in /model with no args shows usage', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/model', createContext());
    expect(result).toContain('Usage');
  });

  it('built-in /tools lists tools', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/tools', createContext());
    expect(result).toContain('tool_a');
  });

  it('built-in /extensions lists extensions', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/extensions', createContext());
    expect(result).toContain('ext_a');
  });

  it('built-in /exit triggers exit', async () => {
    let exited = false;
    const ctx = createContext();
    ctx.exit = () => { exited = true; };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/exit', ctx);
    expect(exited).toBe(true);
  });

  it('built-in /quit also triggers exit', async () => {
    let exited = false;
    const ctx = createContext();
    ctx.exit = () => { exited = true; };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/quit', ctx);
    expect(exited).toBe(true);
  });

  it('built-in /stats shows analytics summary', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/stats', createContext());
    expect(result).toContain('Tool Usage Stats');
    expect(result).toContain('read_file');
  });

  it('built-in /enable without name shows usage', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/enable', createContext());
    expect(result).toContain('Usage');
  });

  it('built-in /enable calls enableExtension callback', async () => {
    let enabledExt = '';
    const ctx = createContext();
    ctx.enableExtension = (name: string) => { enabledExt = name; return `Extension "${name}" enabled.`; };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/enable repomap', ctx);
    expect(enabledExt).toBe('repomap');
  });

  it('built-in /disable without name shows usage', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/disable', createContext());
    expect(result).toContain('Usage');
  });

  it('built-in /disable calls disableExtension callback', async () => {
    let disabledExt = '';
    const ctx = createContext();
    ctx.disableExtension = (name: string) => { disabledExt = name; return `Extension "${name}" disabled.`; };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/disable repomap', ctx);
    expect(disabledExt).toBe('repomap');
  });

  it('built-in /enable shows not-available message when callback missing', async () => {
    const ctx = createContext();
    ctx.enableExtension = undefined;
    registry.registerBuiltins(ctx);
    const result = await registry.tryExecute('/enable repomap', ctx);
    expect(result).toContain('not available');
  });

  it('built-in /config without args shows usage', async () => {
    registry.registerBuiltins(createContext());
    const result = await registry.tryExecute('/config', createContext());
    expect(result).toContain('Usage');
  });

  it('built-in /config with ext calls getExtensionConfig', async () => {
    let calledWith = '';
    const ctx = createContext();
    ctx.getExtensionConfig = (name: string) => { calledWith = name; return 'config data'; };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/config web-search', ctx);
    expect(calledWith).toBe('web-search');
  });

  it('built-in /config with ext key value calls setExtensionConfig', async () => {
    let setName = '', setKey = '', setVal = '';
    const ctx = createContext();
    ctx.setExtensionConfig = (name: string, key: string, value: string) => {
      setName = name; setKey = key; setVal = value; return 'ok';
    };
    registry.registerBuiltins(ctx);
    await registry.tryExecute('/config web-search maxResults 10', ctx);
    expect(setName).toBe('web-search');
    expect(setKey).toBe('maxResults');
    expect(setVal).toBe('10');
  });

  it('built-in /config shows not-available when callbacks missing', async () => {
    const ctx = createContext();
    ctx.getExtensionConfig = undefined;
    ctx.setExtensionConfig = undefined;
    registry.registerBuiltins(ctx);
    const result = await registry.tryExecute('/config web-search', ctx);
    expect(result).toContain('not available');
  });
});
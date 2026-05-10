/**
 * ToolRegistry tests.
 *
 * Covers: register, get, unregister, execute, categories,
 * getLLMDefinitions, getReadOnlyDefinitions.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, type Tool } from '../tools/registry.js';

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ success: true, output: 'done' }),
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(registry.get('test_tool')).toBeDefined();
    expect(registry.get('test_tool')?.name).toBe('test_tool');
  });

  it('returns undefined for unknown tool', () => {
    const registry = new ToolRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('unregisters a tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool());
    expect(registry.unregister('test_tool')).toBe(true);
    expect(registry.get('test_tool')).toBeUndefined();
  });

  it('returns false when unregistering unknown tool', () => {
    const registry = new ToolRegistry();
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('lists all registered tools', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: 'tool_a' }));
    registry.register(makeTool({ name: 'tool_b' }));
    expect(registry.listAll()).toHaveLength(2);
  });

  it('categorizes tools by default category', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: 't1' }));
    const builtin = registry.getByCategory('builtin');
    expect(builtin).toHaveLength(1);
    expect(builtin[0].name).toBe('t1');
  });

  it('categorizes tools by custom category', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: 't1' }), 'ext:foo');
    expect(registry.getByCategory('ext:foo')).toHaveLength(1);
    expect(registry.getByCategory('builtin')).toHaveLength(0);
  });

  it('returns empty array for unknown category', () => {
    const registry = new ToolRegistry();
    expect(registry.getByCategory('nothing')).toEqual([]);
  });

  it('cleans up category on unregister', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: 't1' }), 'ext:foo');
    registry.unregister('t1');
    expect(registry.getByCategory('ext:foo')).toHaveLength(0);
  });

  it('getLLMDefinitions returns all tools stripped of execute', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: 'read_file', readOnly: true }));
    registry.register(makeTool({ name: 'write_file' }));
    const defs = registry.getLLMDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0]).not.toHaveProperty('execute');
    expect(defs[0]).toHaveProperty('name');
    expect(defs[0]).toHaveProperty('description');
    expect(defs[0]).toHaveProperty('inputSchema');
  });

  it('getReadOnlyDefinitions returns only readOnly tools', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: 'read_file', readOnly: true }));
    registry.register(makeTool({ name: 'write_file', readOnly: false }));
    const defs = registry.getReadOnlyDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('read_file');
  });

  it('execute runs tool and returns result', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'greet',
      execute: async (args) => ({
        success: true,
        output: `Hello ${args.name ?? 'world'}!`,
      }),
    }));
    const result = await registry.execute('greet', { name: 'Brick' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('Hello Brick!');
  });

  it('execute returns error for unknown tool', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute('nonexistent', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('execute catches and wraps thrown errors', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'crash',
      execute: async () => { throw new Error('kaboom'); },
    }));
    const result = await registry.execute('crash', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('kaboom');
  });

  describe('result size limits', () => {
    it('applies default 256KB limit', async () => {
      const registry = new ToolRegistry();
      const bigOutput = 'x'.repeat(300_000);
      registry.register(makeTool({
        name: 'big',
        execute: async () => ({ success: true, output: bigOutput }),
      }));
      const result = await registry.execute('big', {});
      expect(result.success).toBe(true);
      expect(result.output.length).toBeLessThan(270_000);
      expect(result.output).toContain('[result truncated to');
    });

    it('allows custom maxResultBytes via constructor', async () => {
      const registry = new ToolRegistry({ maxResultBytes: 100 });
      const bigOutput = 'y'.repeat(500);
      registry.register(makeTool({
        name: 'big',
        execute: async () => ({ success: true, output: bigOutput }),
      }));
      const result = await registry.execute('big', {});
      expect(result.success).toBe(true);
      expect(result.output.length).toBeLessThan(200);
      expect(result.output).toContain('[result truncated to 100 bytes]');
    });

    it('does not truncate output under the limit', async () => {
      const registry = new ToolRegistry({ maxResultBytes: 1000 });
      registry.register(makeTool({
        name: 'small',
        execute: async () => ({ success: true, output: 'small output' }),
      }));
      const result = await registry.execute('small', {});
      expect(result.success).toBe(true);
      expect(result.output).toBe('small output');
    });

    it('handles zero-length output gracefully', async () => {
      const registry = new ToolRegistry({ maxResultBytes: 100 });
      registry.register(makeTool({
        name: 'empty',
        execute: async () => ({ success: true, output: '' }),
      }));
      const result = await registry.execute('empty', {});
      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });
  });
});
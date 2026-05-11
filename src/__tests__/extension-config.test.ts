/**
 * Extension config manager tests.
 *
 * Covers: load/save config, schema access, config merge,
 * setConfig coercion and validation, env var generation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtensionConfigManager } from '../extensions/config.js';
import type { ExtensionRegistry, ExtensionManifest, ExtensionState } from '../extensions/registry.js';

const mockRegistryGet = vi.hoisted(() => vi.fn());

// Create a mock registry that just delegates to mockRegistryGet
const mockRegistry = {
  get: mockRegistryGet,
} as unknown as ExtensionRegistry;

// Mock fs/promises for the config manager
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

function makeExt(name: string, config?: Record<string, any>): ExtensionState {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: 'Test extension',
      type: 'mcp',
      mcp: { command: 'node', args: ['server.js'] },
      capabilities: { tools: [], commands: [], hooks: [] },
      config,
    } as ExtensionManifest,
    path: `/ext/${name}`,
    enabled: true,
    installedAt: new Date().toISOString(),
  };
}

describe('ExtensionConfigManager', () => {
  let manager: ExtensionConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReset();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockRegistryGet.mockReset();

    manager = new ExtensionConfigManager(() => mockRegistry);
  });

  describe('config schema and merge', () => {
    it('returns undefined schema for unknown extension', () => {
      mockRegistryGet.mockReturnValue(undefined);
      expect(manager.getSchema('nonexistent')).toBeUndefined();
    });

    it('returns schema from manifest', () => {
      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: { type: 'number', description: 'Max results', default: 5 },
        safeSearch: { type: 'boolean', description: 'Safe search', default: true },
      }));

      const schema = manager.getSchema('web-search');
      expect(schema).toBeDefined();
      expect(schema!.maxResults.type).toBe('number');
      expect(schema!.maxResults.default).toBe(5);
      expect(schema!.safeSearch.type).toBe('boolean');
    });

    it('hasConfig returns true when extension has config schema', () => {
      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: { type: 'number', description: 'Max results' },
      }));
      expect(manager.hasConfig('web-search')).toBe(true);
    });

    it('hasConfig returns false when no config schema', () => {
      mockRegistryGet.mockReturnValue(makeExt('no-config'));
      expect(manager.hasConfig('no-config')).toBe(false);
    });

    it('getConfig returns defaults when no user overrides', () => {
      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: { type: 'number', description: 'Max results', default: 5 },
        safeSearch: { type: 'boolean', description: 'Safe search', default: true },
        label: { type: 'string', description: 'Label' },
      }));

      const config = manager.getConfig('web-search');
      expect(config.maxResults).toBe(5);
      expect(config.safeSearch).toBe(true);
      expect(config.label).toBeNull(); // no default -> null
    });

    it('getConfig merges user overrides on top of defaults', async () => {
      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: { type: 'number', description: 'Max results', default: 5 },
        safeSearch: { type: 'boolean', description: 'Safe search', default: true },
      }));

      // Simulate loading user overrides by calling setConfig
      manager.setConfig('web-search', 'maxResults', '10');

      const config = manager.getConfig('web-search');
      expect(config.maxResults).toBe(10); // overridden
      expect(config.safeSearch).toBe(true); // still default
    });

    it('setConfig coerces string values correctly', () => {
      mockRegistryGet.mockReturnValue(makeExt('test', {
        count: { type: 'number', description: 'Count', default: 0 },
        active: { type: 'boolean', description: 'Active', default: false },
        name: { type: 'string', description: 'Name' },
      }));

      manager.setConfig('test', 'count', '42');
      manager.setConfig('test', 'active', 'true');
      manager.setConfig('test', 'name', 'hello');

      const config = manager.getConfig('test');
      expect(config.count).toBe(42);
      expect(config.active).toBe(true);
      expect(config.name).toBe('hello');
    });

    it('setConfig validates select type against options', () => {
      mockRegistryGet.mockReturnValue(makeExt('test', {
        theme: {
          type: 'select' as const,
          description: 'Theme',
          options: ['light', 'dark'],
          default: 'light',
        },
      }));

      const result = manager.setConfig('test', 'theme', 'dark');
      expect(result).not.toContain('Invalid');

      const badResult = manager.setConfig('test', 'theme', 'neon');
      expect(badResult).toContain('Invalid');
    });

    it('setConfig returns error for unknown key', () => {
      mockRegistryGet.mockReturnValue(makeExt('test', {
        maxResults: { type: 'number', description: 'Max results' },
      }));

      const result = manager.setConfig('test', 'nonexistent', '42');
      expect(result).toContain('Unknown');
    });

    it('setConfig returns message when extension has no config', () => {
      mockRegistryGet.mockReturnValue(makeExt('no-config'));

      const result = manager.setConfig('no-config', 'key', 'val');
      expect(result).toContain('no configurable settings');
    });
  });

  describe('env var generation', () => {
    it('generates BRICK_CFG_* env vars from config', () => {
      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: { type: 'number', description: 'Max results', default: 5 },
        safeSearch: { type: 'boolean', description: 'Safe search', default: true },
      }));

      const env = manager.getConfigAsEnv('web-search');
      expect(env.BRICK_CFG_MAXRESULTS).toBe('5');
      expect(env.BRICK_CFG_SAFESEARCH).toBe('true');
    });

    it('excludes null/undefined values from env', () => {
      mockRegistryGet.mockReturnValue(makeExt('test', {
        optional: { type: 'string', description: 'Optional' },
      }));

      const env = manager.getConfigAsEnv('test');
      expect(Object.keys(env)).toHaveLength(0);
    });

    it('includes overridden values in env', () => {
      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: { type: 'number', description: 'Max results', default: 5 },
      }));

      manager.setConfig('web-search', 'maxResults', '10');
      const env = manager.getConfigAsEnv('web-search');
      expect(env.BRICK_CFG_MAXRESULTS).toBe('10');
    });
  });

  describe('formatConfig', () => {
    it('returns formatted config string', () => {
      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: {
          type: 'number',
          description: 'Maximum number of results',
          default: 5,
          label: 'Max Results',
        },
        safeSearch: {
          type: 'boolean',
          description: 'Enable safe search',
          default: true,
        },
      }));

      const output = manager.formatConfig('web-search');
      expect(output).toContain('Configuration for "web-search"');
      expect(output).toContain('Max Results');
      expect(output).toContain('5');
      expect(output).toContain('Enable safe search');
    });

    it('returns message when extension has no config', () => {
      mockRegistryGet.mockReturnValue(makeExt('no-config'));

      const output = manager.formatConfig('no-config');
      expect(output).toContain('no configurable settings');
    });
  });

  describe('persistence', () => {
    it('loads configs from file on construction', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify({
        'web-search': { maxResults: 10 },
      }));

      // Recreate manager to trigger load
      const mgr = new ExtensionConfigManager(() => mockRegistry);
      await new Promise(process.nextTick);

      mockRegistryGet.mockReturnValue(makeExt('web-search', {
        maxResults: { type: 'number', description: 'Max results', default: 5 },
      }));

      const config = mgr.getConfig('web-search');
      expect(config.maxResults).toBe(10);
    });

    it('saves configs via writeFile on setConfig', async () => {
      mockExistsSync.mockReturnValue(false);
      mockRegistryGet.mockReturnValue(makeExt('test', {
        key: { type: 'string', description: 'Test key' },
      }));

      const mgr = new ExtensionConfigManager(() => mockRegistry);
      await new Promise(process.nextTick);

      mockWriteFile.mockClear();
      mgr.setConfig('test', 'key', 'value');

      await new Promise(process.nextTick);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const callArgs = mockWriteFile.mock.calls[0];
      expect(callArgs[0]).toContain('extensions-config.json');
      expect(callArgs[1]).toContain('"key": "value"');
    });

    it('handles missing config file silently', async () => {
      mockExistsSync.mockReturnValue(false);

      const mgr = new ExtensionConfigManager(() => mockRegistry);
      await new Promise(process.nextTick);

      mockRegistryGet.mockReturnValue(makeExt('test', {
        key: { type: 'string', description: 'Test key', default: 'default' },
      }));

      const config = mgr.getConfig('test');
      expect(config.key).toBe('default');
    });
  });
});
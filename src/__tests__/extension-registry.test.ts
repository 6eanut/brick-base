/**
 * Extension registry tests.
 *
 * Covers: register, unregister, get, listAll, listEnabled, setEnabled,
 * discover with mocked filesystem, getAllExtensionToolNames.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtensionRegistry } from '../extensions/registry.js';

const mockReadFile = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

describe('ExtensionRegistry', () => {
  let registry: ExtensionRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReset();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    registry = new ExtensionRegistry([]);
  });

  describe('register / unregister / get', () => {
    it('registers an extension', () => {
      registry.register({
        name: 'repomap',
        version: '1.0.0',
        description: 'Repo mapping',
        type: 'mcp',
        mcp: { command: 'node', args: ['server.js'] },
        capabilities: { tools: ['map'], commands: [], hooks: [] },
      }, '/ext/repomap');

      expect(registry.get('repomap')).toBeDefined();
      expect(registry.get('repomap')!.manifest.name).toBe('repomap');
      expect(registry.get('repomap')!.enabled).toBe(true);
    });

    it('unregisters an extension', () => {
      registry.register({
        name: 'web-search',
        version: '0.1.0',
        description: 'Web search',
        type: 'mcp',
        mcp: { command: 'python3', args: ['server.py'] },
        capabilities: { tools: ['search'], commands: [], hooks: [] },
      }, '/ext/web-search');

      expect(registry.unregister('web-search')).toBe(true);
      expect(registry.get('web-search')).toBeUndefined();
    });

    it('unregister returns false for non-existent extension', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });

    it('get returns undefined for non-existent extension', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('listAll / listEnabled', () => {
    it('listAll returns all registered extensions', () => {
      registry.register({
        name: 'a', version: '1.0.0', description: 'A', type: 'mcp',
        mcp: { command: 'a', args: [] },
        capabilities: { tools: [], commands: [], hooks: [] },
      }, '/ext/a');
      registry.register({
        name: 'b', version: '1.0.0', description: 'B', type: 'mcp',
        mcp: { command: 'b', args: [] },
        capabilities: { tools: [], commands: [], hooks: [] },
      }, '/ext/b');

      expect(registry.listAll()).toHaveLength(2);
    });

    it('listEnabled returns only enabled extensions', () => {
      registry.register({
        name: 'a', version: '1.0.0', description: 'A', type: 'mcp',
        mcp: { command: 'a', args: [] },
        capabilities: { tools: [], commands: [], hooks: [] },
      }, '/ext/a');
      registry.register({
        name: 'b', version: '1.0.0', description: 'B', type: 'mcp',
        mcp: { command: 'b', args: [] },
        capabilities: { tools: [], commands: [], hooks: [] },
      }, '/ext/b');

      registry.setEnabled('b', false);

      const enabled = registry.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].manifest.name).toBe('a');
    });
  });

  describe('setEnabled', () => {
    it('returns false for non-existent extension', () => {
      expect(registry.setEnabled('nonexistent', false)).toBe(false);
    });

    it('toggles extension enabled state', () => {
      registry.register({
        name: 'test', version: '1.0.0', description: 'Test', type: 'mcp',
        mcp: { command: 't', args: [] },
        capabilities: { tools: [], commands: [], hooks: [] },
      }, '/ext/test');

      expect(registry.setEnabled('test', false)).toBe(true);
      expect(registry.get('test')!.enabled).toBe(false);
      expect(registry.setEnabled('test', true)).toBe(true);
      expect(registry.get('test')!.enabled).toBe(true);
    });
  });

  describe('discover', () => {
    it('scans search paths and registers extensions with brick.json', async () => {
      registry = new ExtensionRegistry(['/test/extensions']);
      mockExistsSync.mockImplementation((p: string) => {
        if (p === '/test/extensions') return true;
        if (p === '/test/extensions/repomap/brick.json') return true;
        return false;
      });
      mockReaddir.mockResolvedValue([
        { name: 'repomap', isDirectory: () => true, isFile: () => false },
        { name: '.hidden', isDirectory: () => true, isFile: () => false },
        { name: 'readme.md', isDirectory: () => false, isFile: () => true },
      ]);
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'repomap',
        version: '1.0.0',
        description: 'Repo mapping',
        type: 'mcp',
        mcp: { command: 'node', args: ['server.js'] },
        capabilities: { tools: ['map'], commands: ['/map'], hooks: ['post-commit'] },
      }));

      const discovered = await registry.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('repomap');
      expect(discovered[0].capabilities.tools).toEqual(['map']);
      expect(registry.get('repomap')).toBeDefined();
      expect(registry.get('repomap')!.enabled).toBe(true);
    });

    it('skips non-existent search paths', async () => {
      registry = new ExtensionRegistry(['/does/not/exist']);
      mockExistsSync.mockReturnValue(false);

      const discovered = await registry.discover();
      expect(discovered).toHaveLength(0);
    });

    it('skips invalid manifests silently', async () => {
      registry = new ExtensionRegistry(['/test/extensions']);
      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue([
        { name: 'broken', isDirectory: () => true, isFile: () => false },
      ]);
      mockReadFile.mockResolvedValue('not valid json');

      const discovered = await registry.discover();
      expect(discovered).toHaveLength(0);
    });

    it('populates default capability arrays when tools/commands/hooks are missing', async () => {
      registry = new ExtensionRegistry(['/test/extensions']);
      mockExistsSync.mockImplementation((p: string) =>
        p === '/test/extensions' || p === '/test/extensions/minimal/brick.json'
      );
      mockReaddir.mockResolvedValue([
        { name: 'minimal', isDirectory: () => true, isFile: () => false },
      ]);
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'minimal',
        version: '0.1.0',
        description: 'Minimal extension',
        type: 'mcp',
        mcp: { command: 'node', args: ['server.js'] },
        capabilities: { tools: undefined, commands: undefined, hooks: undefined },
      }));

      const discovered = await registry.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].capabilities.tools).toEqual([]);
      expect(discovered[0].capabilities.commands).toEqual([]);
      expect(discovered[0].capabilities.hooks).toEqual([]);
    });

    it('skips manifests with missing capabilities entirely', async () => {
      registry = new ExtensionRegistry(['/test/extensions']);
      mockExistsSync.mockReturnValue(true);
      mockReaddir.mockResolvedValue([
        { name: 'bad', isDirectory: () => true, isFile: () => false },
      ]);
      mockReadFile.mockResolvedValue(JSON.stringify({
        name: 'bad',
        version: '0.1.0',
        description: 'Bad extension',
        type: 'mcp',
        mcp: { command: 'node', args: ['server.js'] },
      }));

      const discovered = await registry.discover();
      expect(discovered).toHaveLength(0);
    });
  });

  describe('getAllExtensionToolNames', () => {
    it('returns tool names from all enabled extensions', () => {
      registry.register({
        name: 'a', version: '1.0.0', description: 'A', type: 'mcp',
        mcp: { command: 'a', args: [] },
        capabilities: { tools: ['tool_a', 'tool_b'], commands: [], hooks: [] },
      }, '/ext/a');
      registry.register({
        name: 'b', version: '1.0.0', description: 'B', type: 'mcp',
        mcp: { command: 'b', args: [] },
        capabilities: { tools: ['tool_c'], commands: [], hooks: [] },
      }, '/ext/b');

      const names = registry.getAllExtensionToolNames();
      expect(names).toEqual(['tool_a', 'tool_b', 'tool_c']);
    });

    it('excludes tool names from disabled extensions', () => {
      registry.register({
        name: 'a', version: '1.0.0', description: 'A', type: 'mcp',
        mcp: { command: 'a', args: [] },
        capabilities: { tools: ['tool_a'], commands: [], hooks: [] },
      }, '/ext/a');
      registry.setEnabled('a', false);

      expect(registry.getAllExtensionToolNames()).toEqual([]);
    });
  });
});
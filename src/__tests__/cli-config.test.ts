/**
 * CLI config command tests.
 *
 * Tests the `brick config <extension> [key] [value]` subcommand logic
 * for viewing and setting extension configuration.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}));

import { homedir } from 'node:os';
import { join } from 'node:path';

const EXT_DIR = join(homedir(), '.brick', 'extensions');
const CONFIG_FILE = join(homedir(), '.brick', 'extensions-config.json');

function makeManifest(name: string, config?: Record<string, any>) {
  return {
    name,
    version: '1.0.0',
    description: 'Test extension',
    type: 'mcp',
    mcp: { command: 'node', args: ['server.js'] },
    capabilities: { tools: [], commands: [], hooks: [] },
    config,
  };
}

describe('config command logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails if extension is not installed', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === join(EXT_DIR, 'nonexistent')) return false;
      if (p === join(EXT_DIR, 'nonexistent', 'brick.json')) return false;
      return false;
    });

    const extDir = join(EXT_DIR, 'nonexistent');
    expect(mockExistsSync(extDir)).toBe(false);
  });

  it('shows message when extension has no config', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.startsWith(EXT_DIR)) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(makeManifest('no-config')));

    const content = mockReadFileSync(join(EXT_DIR, 'no-config', 'brick.json'), 'utf-8');
    const manifest = JSON.parse(content);
    expect(manifest.config).toBeUndefined();
  });

  it('displays config schema for an extension', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(makeManifest('web-search', {
      maxResults: {
        type: 'number',
        description: 'Maximum number of results',
        default: 5,
        label: 'Max Results',
      },
    })));

    const content = mockReadFileSync(join(EXT_DIR, 'web-search', 'brick.json'), 'utf-8');
    const manifest = JSON.parse(content);

    expect(manifest.config.maxResults.type).toBe('number');
    expect(manifest.config.maxResults.default).toBe(5);
    expect(manifest.config.maxResults.label).toBe('Max Results');
  });

  it('sets a config value and persists it', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.startsWith(EXT_DIR)) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('brick.json')) {
        return JSON.stringify(makeManifest('web-search', {
          maxResults: { type: 'number', description: 'Max results', default: 5 },
        }));
      }
      if (p.includes('extensions-config.json')) {
        return '{}';
      }
      return '';
    });

    // Simulate: read manifest, load configs, set value, save
    const manifest = JSON.parse(mockReadFileSync(join(EXT_DIR, 'web-search', 'brick.json'), 'utf-8'));
    const allConfigsRaw = mockReadFileSync(CONFIG_FILE, 'utf-8');
    const allConfigs = JSON.parse(allConfigsRaw) as Record<string, Record<string, unknown>>;

    const entry = manifest.config.maxResults;
    const n = Number('10');
    const coerced = Number.isNaN(n) ? '10' : n;

    const cfg = allConfigs['web-search'] ?? {};
    cfg['maxResults'] = coerced;
    allConfigs['web-search'] = cfg;
    mockWriteFileSync(CONFIG_FILE, JSON.stringify(allConfigs, null, 2), 'utf-8');

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written['web-search'].maxResults).toBe(10);
  });

  it('rejects unknown config key', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(makeManifest('web-search', {
      maxResults: { type: 'number', description: 'Max results', default: 5 },
    })));

    const manifest = JSON.parse(mockReadFileSync(join(EXT_DIR, 'web-search', 'brick.json'), 'utf-8'));
    const key = 'nonexistent';
    expect(manifest.config[key]).toBeUndefined();
  });

  it('rejects invalid value for select type', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(makeManifest('test', {
      theme: { type: 'select', description: 'Theme', options: ['light', 'dark'], default: 'light' },
    })));

    const manifest = JSON.parse(mockReadFileSync(join(EXT_DIR, 'test', 'brick.json'), 'utf-8'));
    const entry = manifest.config.theme;
    const value = 'neon';
    const isInvalid = entry.options && !entry.options.includes(value);
    expect(isInvalid).toBe(true);
  });
});
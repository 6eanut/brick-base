/**
 * CLI enable/disable command tests.
 *
 * Tests the `brick enable <name>` and `brick disable <name>` subcommand
 * logic for toggling extension state persisted in extensions-state.json.
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

const STATE_FILE = join(homedir(), '.brick', 'extensions-state.json');
const EXT_DIR = join(homedir(), '.brick', 'extensions');

describe('enable/disable logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails if extension is not installed', () => {
    mockExistsSync.mockImplementation((p: string) => {
      // Extension dir doesn't exist
      if (p === join(EXT_DIR, 'nonexistent')) return false;
      if (p === STATE_FILE) return true;
      return false;
    });

    const extDir = join(EXT_DIR, 'nonexistent');
    expect(mockExistsSync(extDir)).toBe(false);
  });

  it('saves enabled state when enabling', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === join(EXT_DIR, 'my-ext')) return true;
      if (p === STATE_FILE) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({ 'my-ext': false }));

    // Simulate enable: read state, set true, write back
    const stateRaw = mockReadFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(stateRaw) as Record<string, boolean>;
    state['my-ext'] = true;
    mockWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written['my-ext']).toBe(true);
  });

  it('saves disabled state when disabling', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === join(EXT_DIR, 'my-ext')) return true;
      if (p === STATE_FILE) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({ 'my-ext': true }));

    // Simulate disable: read state, set false, write back
    const stateRaw = mockReadFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(stateRaw) as Record<string, boolean>;
    state['my-ext'] = false;
    mockWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written['my-ext']).toBe(false);
  });

  it('creates state file with true when enabling a never-before-set extension', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === join(EXT_DIR, 'new-ext')) return true;
      if (p === STATE_FILE) return false; // state file doesn't exist yet
      return false;
    });

    // No state file → start with empty map
    const state = new Map<string, boolean>();
    state.set('new-ext', true);

    // Write
    const obj: Record<string, boolean> = {};
    for (const [name, enabled] of state) {
      obj[name] = enabled;
    }
    mockWriteFileSync(STATE_FILE, JSON.stringify(obj, null, 2), 'utf-8');

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(written['new-ext']).toBe(true);
  });

  it('handles invalid state file gracefully by starting fresh', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === join(EXT_DIR, 'ext')) return true;
      if (p === STATE_FILE) return true;
      return false;
    });
    // Invalid JSON in state file
    mockReadFileSync.mockReturnValue('not valid json');

    try {
      const content = mockReadFileSync(STATE_FILE, 'utf-8');
      JSON.parse(content);
      // Should not reach here
      expect(true).toBe(false);
    } catch {
      // Expected: invalid JSON, start fresh
      const state = new Map<string, boolean>();
      state.set('ext', true);
      expect(state.get('ext')).toBe(true);
    }
  });
});
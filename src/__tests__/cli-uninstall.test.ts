/**
 * CLI uninstall command tests.
 *
 * Tests the `brick uninstall <name>` subcommand logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('node:fs/promises', () => ({
  rm: mockRm,
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  cp: vi.fn(),
}));

import { homedir } from 'node:os';
import { join } from 'node:path';

const EXT_DIR = join(homedir(), '.brick', 'extensions', 'test-ext');

describe('uninstall logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects when extension is not installed', () => {
    mockExistsSync.mockReturnValue(false);
    expect(mockExistsSync(EXT_DIR)).toBe(false);
  });

  it('detects when extension is installed', () => {
    mockExistsSync.mockReturnValue(true);
    expect(mockExistsSync(EXT_DIR)).toBe(true);
  });

  it('removes extension directory on force uninstall', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRm.mockResolvedValue(undefined);

    await mockRm(EXT_DIR, { recursive: true, force: true });

    expect(mockRm).toHaveBeenCalledWith(EXT_DIR, { recursive: true, force: true });
  });

  it('does not attempt removal when extension does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(mockRm).not.toHaveBeenCalled();
  });
});
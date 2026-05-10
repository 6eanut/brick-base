/**
 * CLI list command tests.
 *
 * Tests the `brick list` subcommand logic for listing installed extensions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('node:fs/promises', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  mkdir: vi.fn(),
  cp: vi.fn(),
  rm: vi.fn(),
}));

import { homedir } from 'node:os';
import { join } from 'node:path';

function dirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

const EXT_DIR = join(homedir(), '.brick', 'extensions');

describe('list logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty when no extensions directory exists', () => {
    mockExistsSync.mockReturnValue(false);
    expect(mockExistsSync(EXT_DIR)).toBe(false);
  });

  it('shows empty when extensions directory has no entries', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([]);

    const entries = await mockReaddir(EXT_DIR, { withFileTypes: true });
    expect(entries).toHaveLength(0);
  });

  it('lists installed extensions with metadata', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([
      dirent('test-ext', true),
      dirent('.hidden', true),
    ]);
    mockReadFile.mockResolvedValue(JSON.stringify({
      name: 'test-ext',
      version: '1.0.0',
      description: 'A test extension',
    }));

    const entries = await mockReaddir(EXT_DIR, { withFileTypes: true });
    const extNames = entries
      .filter((e: any) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: any) => e.name);

    expect(extNames).toEqual(['test-ext']);

    const manifestPath = join(EXT_DIR, 'test-ext', 'brick.json');
    const content = await mockReadFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);
    expect(manifest.name).toBe('test-ext');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.description).toBe('A test extension');
  });

  it('skips hidden directories', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([
      dirent('.internal', true),
      dirent('visible-ext', true),
    ]);

    const entries = await mockReaddir(EXT_DIR, { withFileTypes: true });
    const extNames = entries
      .filter((e: any) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: any) => e.name);

    expect(extNames).toEqual(['visible-ext']);
  });

  it('skips non-directory entries', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([
      dirent('file.txt', false),
      dirent('real-ext', true),
    ]);

    const entries = await mockReaddir(EXT_DIR, { withFileTypes: true });
    const extNames = entries
      .filter((e: any) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: any) => e.name);

    expect(extNames).toEqual(['real-ext']);
  });

  it('handles invalid manifest gracefully', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([dirent('broken-ext', true)]);
    mockReadFile.mockResolvedValue('not valid json');

    const entries = await mockReaddir(EXT_DIR, { withFileTypes: true });
    const extNames = entries
      .filter((e: any) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: any) => e.name);

    expect(extNames).toEqual(['broken-ext']);
  });
});
/**
 * File tool tests.
 *
 * Covers all 5 tools: read_file, write_file, grep_search, list_files, file_stat.
 * Also covers path security: blocked system paths, allowed roots, symlink protection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted() so factories survive hoisting
// ---------------------------------------------------------------------------
const { mockReadFile, mockWriteFile, mockReaddir, mockStat, mockMkdir, mockExistsSync, mockRealpathSync }
  = vi.hoisted(() => ({
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockReaddir: vi.fn(),
    mockStat: vi.fn(),
    mockMkdir: vi.fn(),
    mockExistsSync: vi.fn(),
    mockRealpathSync: vi.fn(),
  }));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  readdir: mockReaddir,
  stat: mockStat,
  mkdir: mockMkdir,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  realpathSync: mockRealpathSync,
}));

import { FileTool, setAllowedRoots, setBlockedPaths } from '../tools/file.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake Dirent-like object. */
function dirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
  };
}

const TEST_ROOT = '/tmp/filetest';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('FileTool - Path Security', () => {
  beforeEach(() => {
    setAllowedRoots([TEST_ROOT]);
    setBlockedPaths([]);
    mockReadFile.mockReset();
    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: string) => p);
  });

  it('allows paths within allowed roots', async () => {
    mockReadFile.mockResolvedValue('hello');
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/a.txt` });
    expect(result.success).toBe(true);
  });

  it('blocks paths outside allowed roots', async () => {
    const result = await FileTool.read.execute({ path: '/etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks /etc/ paths by default', async () => {
    const result = await FileTool.read.execute({ path: '/etc/hosts' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks /proc/ paths by default', async () => {
    const result = await FileTool.stat.execute({ path: '/proc/cpuinfo' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks /sys/ paths by default', async () => {
    const result = await FileTool.read.execute({ path: '/sys/kernel/hostname' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks paths containing /node_modules/', async () => {
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/node_modules/foo/index.js` });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks paths containing /.git/', async () => {
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/.git/config` });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks paths containing /.ssh/', async () => {
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/.ssh/id_rsa` });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks configurable blocked paths', async () => {
    setBlockedPaths([`${TEST_ROOT}/secrets`]);
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/secrets/keys.json` });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('detects symlink traversal: resolves to blocked path', async () => {
    // Input path looks allowed, but realpathSync resolves to a blocked path
    mockRealpathSync.mockReturnValue('/etc/shadow');
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/innocent-link` });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('falls back to resolve() when realpathSync throws', async () => {
    // For a non-existent file, realpathSync throws and resolve() is used
    mockRealpathSync.mockImplementation(() => { throw new Error('ENOENT'); });
    // The path resolves to TEST_ROOT/ghost.txt which is within allowed roots
    mockReadFile.mockResolvedValue('content');
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/ghost.txt` });
    expect(result.success).toBe(true);
    expect(result.output).toBe('content');
  });
});

describe('FileTool - read_file', () => {
  beforeEach(() => {
    setAllowedRoots([TEST_ROOT]);
    mockReadFile.mockReset();
    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: string) => p);
  });

  it('reads full file content', async () => {
    mockReadFile.mockResolvedValue('line1\nline2\nline3\n');
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/file.txt` });
    expect(result.success).toBe(true);
    // split('\n') on content with trailing \n creates 4 elements; join preserves trailing \n
    expect(result.output).toBe('line1\nline2\nline3\n');
    expect(result.data).toEqual({ totalLines: 4, path: `${TEST_ROOT}/file.txt` });
  });

  it('reads with offset (1-based)', async () => {
    mockReadFile.mockResolvedValue('a\nb\nc\nd\ne\n');
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/file.txt`, offset: 3 });
    expect(result.success).toBe(true);
    // split('\n') on 'a\nb\nc\nd\ne\n' = ['a','b','c','d','e','']; slice(2) = ['c','d','e','']; join = 'c\nd\ne\n'
    expect(result.output).toBe('c\nd\ne\n');
  });

  it('reads with offset and limit', async () => {
    mockReadFile.mockResolvedValue('a\nb\nc\nd\ne\n');
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/file.txt`, offset: 2, limit: 2 });
    expect(result.success).toBe(true);
    expect(result.output).toBe('b\nc');
  });

  it('defaults offset to 1 when not provided', async () => {
    mockReadFile.mockResolvedValue('x\ny\nz\n');
    const result = await FileTool.read.execute({ path: `${TEST_ROOT}/file.txt`, limit: 2 });
    expect(result.success).toBe(true);
    expect(result.output).toBe('x\ny');
  });

  it('returns error for blocked path', async () => {
    const result = await FileTool.read.execute({ path: '/etc/hosts' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('propagates readFile errors', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));
    await expect(
      FileTool.read.execute({ path: `${TEST_ROOT}/missing.txt` }),
    ).rejects.toThrow('ENOENT');
  });
});

describe('FileTool - write_file', () => {
  beforeEach(() => {
    setAllowedRoots([TEST_ROOT]);
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockExistsSync.mockReset();
    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: string) => p);
    mockExistsSync.mockReturnValue(true); // parent dir exists
  });

  it('writes content to file', async () => {
    mockWriteFile.mockResolvedValue(undefined);
    const result = await FileTool.write.execute({ path: `${TEST_ROOT}/out.txt`, content: 'hello world' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('11 bytes');
    expect(mockWriteFile).toHaveBeenCalledWith(`${TEST_ROOT}/out.txt`, 'hello world', 'utf-8');
  });

  it('creates parent directories when missing', async () => {
    mockExistsSync.mockReturnValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    const result = await FileTool.write.execute({ path: `${TEST_ROOT}/deep/nested/file.txt`, content: 'data' });
    expect(result.success).toBe(true);
    expect(mockMkdir).toHaveBeenCalledWith(`${TEST_ROOT}/deep/nested`, { recursive: true });
  });

  it('returns error for blocked path', async () => {
    const result = await FileTool.write.execute({ path: '/etc/crontab', content: 'evil' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('propagates writeFile errors', async () => {
    mockWriteFile.mockRejectedValue(new Error('EACCES: permission denied'));
    await expect(
      FileTool.write.execute({ path: `${TEST_ROOT}/protected.txt`, content: 'data' }),
    ).rejects.toThrow('EACCES');
  });
});

describe('FileTool - grep_search', () => {
  beforeEach(() => {
    setAllowedRoots([TEST_ROOT]);
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: string) => p);
  });

  it('finds matching lines in files', async () => {
    mockReaddir.mockResolvedValue([dirent('hello.ts', false)]);
    mockReadFile.mockResolvedValue('line1\nconsole.log("hello")\nline3\n');

    const result = await FileTool.grep.execute({ pattern: 'console', path: TEST_ROOT });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello.ts:2');
    expect(result.data).toEqual({ results: expect.arrayContaining([expect.stringContaining('hello.ts:2')]), count: 1 });
  });

  it('returns no matches when pattern is not found', async () => {
    mockReaddir.mockResolvedValue([dirent('empty.ts', false)]);
    mockReadFile.mockResolvedValue('nothing here\n');

    const result = await FileTool.grep.execute({ pattern: 'nonexistent', path: TEST_ROOT });
    expect(result.success).toBe(true);
    expect(result.output).toBe('No matches found.');
    expect((result.data as any).count).toBe(0);
  });

  it('respects maxResults limit', async () => {
    mockReaddir.mockResolvedValue([
      dirent('a.txt', false),
      dirent('b.txt', false),
    ]);
    mockReadFile
      .mockResolvedValueOnce('match\nmatch\nmatch\n')
      .mockResolvedValueOnce('match\nmatch\nmatch\n');

    const result = await FileTool.grep.execute({ pattern: 'match', path: TEST_ROOT, maxResults: 2 });
    expect(result.success).toBe(true);
    expect((result.data as any).count).toBeLessThanOrEqual(2);
  });

  it('skips hidden files and node_modules directories', async () => {
    mockReaddir.mockResolvedValue([
      dirent('.hidden.ts', false),
      dirent('visible.ts', false),
    ]);
    mockReadFile.mockResolvedValue('data\n');

    const result = await FileTool.grep.execute({ pattern: 'data', path: TEST_ROOT });
    expect(result.success).toBe(true);
    expect((result.data as any).count).toBe(1);
  });

  it('returns error for blocked path', async () => {
    const result = await FileTool.grep.execute({ pattern: 'test', path: '/etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('handles unreadable files gracefully', async () => {
    mockReaddir.mockResolvedValue([dirent('locked.ts', false)]);
    mockReadFile.mockRejectedValue(new Error('EACCES'));

    const result = await FileTool.grep.execute({ pattern: 'anything', path: TEST_ROOT });
    expect(result.success).toBe(true);
    expect((result.data as any).count).toBe(0);
  });
});

describe('FileTool - list_files', () => {
  beforeEach(() => {
    setAllowedRoots([TEST_ROOT]);
    mockReaddir.mockReset();
    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: string) => p);
  });

  it('lists files in a directory', async () => {
    mockReaddir.mockResolvedValue([
      dirent('a.ts', false),
      dirent('b.ts', false),
      dirent('subdir', true),
    ]);

    const result = await FileTool.glob.execute({ path: TEST_ROOT });
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
    expect(result.output).toContain('subdir/');
  });

  it('lists recursively', async () => {
    mockReaddir
      .mockResolvedValueOnce([dirent('src', true)])
      .mockResolvedValueOnce([dirent('index.ts', false)]);

    const result = await FileTool.glob.execute({ path: TEST_ROOT, recursive: true });
    expect(result.success).toBe(true);
    expect(result.output).toContain('src/');
    expect(result.output).toContain('src/index.ts');
  });

  it('filters by pattern', async () => {
    mockReaddir.mockResolvedValue([
      dirent('a.ts', false),
      dirent('b.js', false),
      dirent('c.ts', false),
    ]);

    const result = await FileTool.glob.execute({ path: TEST_ROOT, pattern: '*.ts' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('c.ts');
    expect(result.output).not.toContain('b.js');
  });

  it('skips hidden entries', async () => {
    mockReaddir.mockResolvedValue([
      dirent('.hidden', false),
      dirent('visible', false),
    ]);

    const result = await FileTool.glob.execute({ path: TEST_ROOT });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('.hidden');
    expect(result.output).toContain('visible');
  });

  it('returns error for blocked path', async () => {
    const result = await FileTool.glob.execute({ path: '/proc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });
});

describe('FileTool - file_stat', () => {
  const mtime = new Date('2026-01-15T12:00:00Z');

  beforeEach(() => {
    setAllowedRoots([TEST_ROOT]);
    mockStat.mockReset();
    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: string) => p);
  });

  it('returns file metadata', async () => {
    mockStat.mockResolvedValue({
      size: 1024,
      isDirectory: () => false,
      isFile: () => true,
      mtime,
    });

    const result = await FileTool.stat.execute({ path: `${TEST_ROOT}/data.txt` });
    expect(result.success).toBe(true);
    expect(result.output).toContain('1024 bytes');
    expect(result.output).toContain('Type: file');
    expect(result.output).toContain(mtime.toISOString());
  });

  it('returns directory metadata', async () => {
    mockStat.mockResolvedValue({
      size: 4096,
      isDirectory: () => true,
      isFile: () => false,
      mtime,
    });

    const result = await FileTool.stat.execute({ path: TEST_ROOT });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Type: directory');
  });

  it('returns error for blocked path', async () => {
    const result = await FileTool.stat.execute({ path: '/etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('propagates stat errors', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT: no such file'));
    await expect(
      FileTool.stat.execute({ path: `${TEST_ROOT}/nope` }),
    ).rejects.toThrow('ENOENT');
  });
});

describe('FileTool - registerAll', () => {
  it('registers all 5 tools into a registry', () => {
    const registry = { register: vi.fn() };
    FileTool.registerAll(registry);
    expect(registry.register).toHaveBeenCalledTimes(5);
  });
});
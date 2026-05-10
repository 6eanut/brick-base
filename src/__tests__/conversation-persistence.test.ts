/**
 * ConversationManager persistence tests.
 *
 * Covers resume(), deletePersisted(), persist() with mocked filesystem.
 * Separate from conversation.test.ts to avoid mock conflicts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationManager } from '../agent/conversation.js';

const mockMkdir = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  readdir: mockReaddir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  rm: mockRm,
}));

describe('ConversationManager – resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockReset();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockMkdir.mockResolvedValue(undefined);
  });

  it('creates new conversation when no persisted files exist', async () => {
    mockReaddir.mockResolvedValue([]);
    const manager = new ConversationManager(true);
    const conv = await manager.resume();
    expect(conv).toBeDefined();
    expect(conv.messages).toHaveLength(0);
  });

  it('loads most recent conversation from disk', async () => {
    mockReaddir.mockResolvedValue(['conv-100.json', 'conv-200.json']);
    mockReadFile.mockResolvedValue(JSON.stringify({
      id: 'conv-200',
      messages: [{ role: 'user', content: 'Hello' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));

    const manager = new ConversationManager(true);
    const conv = await manager.resume();
    expect(conv.id).toBe('conv-200');
    expect(conv.messages).toHaveLength(1);
    expect(manager.getActive().id).toBe('conv-200');
  });

  it('handles invalid JSON gracefully', async () => {
    mockReaddir.mockResolvedValue(['conv-100.json']);
    mockReadFile.mockResolvedValue('not valid json');

    const manager = new ConversationManager(true);
    const conv = await manager.resume();
    expect(conv).toBeDefined();
  });

  it('handles missing id field in persisted data', async () => {
    mockReaddir.mockResolvedValue(['conv-100.json']);
    mockReadFile.mockResolvedValue(JSON.stringify({ notMessages: true }));

    const manager = new ConversationManager(true);
    const conv = await manager.resume();
    expect(conv).toBeDefined();
  });

  it('does nothing when persistence is disabled', async () => {
    const manager = new ConversationManager(false);
    const conv = await manager.resume();
    expect(conv).toBeDefined();
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('handles mkdir failure gracefully', async () => {
    mockMkdir.mockRejectedValue(new Error('EACCES'));
    const manager = new ConversationManager(true);
    const conv = await manager.resume();
    expect(conv).toBeDefined();
  });
});

describe('ConversationManager – deletePersisted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRm.mockReset();
    mockRm.mockResolvedValue(undefined);
  });

  it('removes a conversation file', async () => {
    const manager = new ConversationManager(true);
    await expect(manager.deletePersisted('conv-100')).resolves.toBeUndefined();
  });

  it('handles rm failure gracefully', async () => {
    mockRm.mockRejectedValue(new Error('ENOENT'));
    const manager = new ConversationManager(true);
    await expect(manager.deletePersisted('conv-nonexistent')).resolves.toBeUndefined();
  });
});
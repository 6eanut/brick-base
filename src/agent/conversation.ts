/**
 * Conversation manager.
 *
 * Manages a multi-turn conversation: stores messages, supports
 * system prompts, and provides the message array for LLM API calls.
 * Persists conversations to disk for session-to-session continuity.
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface Conversation {
  id: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

const CONVERSATIONS_DIR = join(homedir(), '.brick', 'conversations');

export class ConversationManager {
  private conversations: Map<string, Conversation> = new Map();
  private activeId: string | null = null;
  private persistEnabled: boolean = true;

  constructor(persistEnabled?: boolean) {
    this.persistEnabled = persistEnabled ?? true;
    // If persistence is enabled but no conversations loaded yet, create one
    if (!this.activeId) {
      this.create();
    }
  }

  /**
   * Create a new conversation and set it as active.
   */
  create(metadata?: Record<string, unknown>): Conversation {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv: Conversation = {
      id,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata,
    };
    this.conversations.set(id, conv);
    this.activeId = id;
    return conv;
  }

  /**
   * Get the active conversation.
   */
  getActive(): Conversation {
    const conv = this.activeId ? this.conversations.get(this.activeId) : undefined;
    if (!conv) {
      return this.create();
    }
    return conv;
  }

  /**
   * Switch to a different conversation by ID.
   */
  switchTo(id: string): Conversation | undefined {
    const conv = this.conversations.get(id);
    if (conv) {
      this.activeId = id;
    }
    return conv;
  }

  /**
   * Add a system prompt message (at the beginning).
   */
  setSystemPrompt(prompt: string): void {
    const conv = this.getActive();
    // Remove existing system messages
    conv.messages = conv.messages.filter(m => m.role !== 'system');
    // Add system message at the beginning
    conv.messages.unshift({ role: 'system', content: prompt });
    conv.updatedAt = new Date().toISOString();
  }

  /**
   * Add a user message.
   */
  addUserMessage(content: string): void {
    const conv = this.getActive();
    conv.messages.push({ role: 'user', content });
    conv.updatedAt = new Date().toISOString();
  }

  /**
   * Add an assistant message.
   */
  addAssistantMessage(content: string): void {
    const conv = this.getActive();
    conv.messages.push({ role: 'assistant', content });
    conv.updatedAt = new Date().toISOString();
  }

  /**
   * Add a tool result message.
   */
  addToolMessage(toolCallId: string, toolName: string, content: string): void {
    const conv = this.getActive();
    conv.messages.push({ role: 'tool', content, toolCallId, toolName });
    conv.updatedAt = new Date().toISOString();
  }

  /**
   * Get all messages for the active conversation.
   */
  getMessages(): Message[] {
    return [...this.getActive().messages];
  }

  /**
   * Get messages excluding system prompts (for token counting).
   */
  getNonSystemMessages(): Message[] {
    return this.getActive().messages.filter(m => m.role !== 'system');
  }

  /**
   * Clear all messages (keep system prompt).
   */
  clear(): void {
    const conv = this.getActive();
    const systemMessages = conv.messages.filter(m => m.role === 'system');
    conv.messages = systemMessages;
    conv.updatedAt = new Date().toISOString();
  }

  /**
   * List all conversations.
   */
  listAll(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  /**
   * Persist the active conversation to disk.
   * Called automatically after every mutation.
   */
  async persist(): Promise<void> {
    if (!this.persistEnabled) return;
    const conv = this.getActive();
    try {
      await mkdir(CONVERSATIONS_DIR, { recursive: true });
      const filePath = join(CONVERSATIONS_DIR, `${conv.id}.json`);
      await writeFile(filePath, JSON.stringify(conv, null, 2), 'utf-8');
    } catch (err) {
      // Silently fail — persistence is best-effort
    }
  }

  /**
   * Load the most recent conversation from disk, if any.
   * Falls back to creating a new conversation.
   */
  async resume(): Promise<Conversation> {
    if (!this.persistEnabled) return this.create();
    try {
      await mkdir(CONVERSATIONS_DIR, { recursive: true });
      const files = await readdir(CONVERSATIONS_DIR);
      const jsonFiles = files
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();

      if (jsonFiles.length === 0) return this.create();

      const latest = jsonFiles[0];
      const content = await readFile(join(CONVERSATIONS_DIR, latest), 'utf-8');
      const conv = JSON.parse(content) as Conversation;

      // Validate basic structure
      if (!conv.id || !Array.isArray(conv.messages)) {
        return this.create();
      }

      this.conversations.set(conv.id, conv);
      this.activeId = conv.id;
      return conv;
    } catch {
      return this.create();
    }
  }

  /**
   * Delete a conversation file from disk.
   */
  async deletePersisted(id: string): Promise<void> {
    try {
      const filePath = join(CONVERSATIONS_DIR, `${id}.json`);
      await import('node:fs/promises').then(fs => fs.rm(filePath, { force: true }));
    } catch {
      // Best-effort
    }
  }
}
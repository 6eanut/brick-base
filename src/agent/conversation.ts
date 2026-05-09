/**
 * Conversation manager.
 *
 * Manages a multi-turn conversation: stores messages, supports
 * system prompts, and provides the message array for LLM API calls.
 */

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

export class ConversationManager {
  private conversations: Map<string, Conversation> = new Map();
  private activeId: string | null = null;

  constructor() {
    this.create();
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
}
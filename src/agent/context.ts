/**
 * Context manager.
 *
 * Handles context window management:
 * - Token counting (approximate)
 * - Truncation when approaching limits
 * - Prioritizing recent and important messages
 */

export interface ContextOptions {
  /** Maximum total tokens before truncation */
  maxTokens: number;
  /** Tokens reserved for the response (not counted in context) */
  reserveResponseTokens: number;
  /** Number of recent messages to always keep */
  keepRecentMessages: number;
}

const DEFAULT_OPTIONS: ContextOptions = {
  maxTokens: 128_000,
  reserveResponseTokens: 4_000,
  keepRecentMessages: 10,
};

export class ContextManager {
  private options: ContextOptions;

  constructor(options?: Partial<ContextOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Rough token count estimation (chars / 4, ~English).
   * For production, use a proper tokenizer.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate total tokens in a list of messages.
   */
  estimateMessageTokens(messages: Array<{ role: string; content: string }>): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(msg.content);
      total += 4; // Approximate overhead per message
    }
    return total;
  }

  /**
   * Truncate messages to fit within the context window.
   * Strategy: keep system prompt + recent messages, drop older middle messages.
   */
  truncateMessages<T extends { role: string; content: string }>(
    messages: T[],
  ): T[] {
    const usableTokens = this.options.maxTokens - this.options.reserveResponseTokens;
    const currentTokens = this.estimateMessageTokens(messages);

    if (currentTokens <= usableTokens) {
      return messages;
    }

    // Separate system messages from the rest
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Always keep the most recent messages
    const recentMessages = nonSystemMessages.slice(-this.options.keepRecentMessages);
    const olderMessages = nonSystemMessages.slice(0, -this.options.keepRecentMessages);

    // Calculate how many older messages we can keep
    const recentTokens = this.estimateMessageTokens(recentMessages);
    const systemTokens = this.estimateMessageTokens(systemMessages);
    const availableForOld = usableTokens - recentTokens - systemTokens;

    let keepOld: T[] = [];
    let oldTokens = 0;
    for (const msg of olderMessages) {
      const msgTokens = this.estimateTokens(msg.content) + 4;
      if (oldTokens + msgTokens <= availableForOld) {
        keepOld.push(msg);
        oldTokens += msgTokens;
      } else {
        break;
      }
    }

    if (keepOld.length < olderMessages.length) {
      // Add a summary marker
      const dropped = olderMessages.length - keepOld.length;
      const summaryMsg = {
        role: 'system' as const,
        content: `[${dropped} older messages omitted due to context window limits]`,
      } as unknown as T;
      return [...systemMessages, summaryMsg, ...keepOld, ...recentMessages];
    }

    return [...systemMessages, ...keepOld, ...recentMessages];
  }

  /**
   * Update max tokens (e.g. when switching models).
   */
  setMaxTokens(max: number): void {
    this.options.maxTokens = max;
  }
}
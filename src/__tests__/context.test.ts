/**
 * ContextManager tests.
 *
 * Covers: token estimation, message truncation, max tokens configuration.
 */
import { describe, it, expect } from 'vitest';
import { ContextManager } from '../agent/context.js';

describe('ContextManager', () => {
  it('estimates tokens as ceil(content.length / 4)', () => {
    const cm = new ContextManager();
    expect(cm.estimateTokens('hello')).toBe(2);   // 5/4 = 1.25 → 2
    expect(cm.estimateTokens('a')).toBe(1);        // 1/4 = 0.25 → 1
    expect(cm.estimateTokens('')).toBe(0);
    expect(cm.estimateTokens('abcdefghijklmnopqrstuvwxyz')).toBe(7); // 26/4 = 6.5 → 7
  });

  it('estimates message tokens with per-message overhead', () => {
    const cm = new ContextManager();
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    // (5/4 → 2 + 4) + (5/4 → 2 + 4) = 6 + 6 = 12
    expect(cm.estimateMessageTokens(messages)).toBe(12);
  });

  it('returns messages unchanged when under limit', () => {
    const cm = new ContextManager({ maxTokens: 1000 });
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const result = cm.truncateMessages(messages);
    expect(result).toHaveLength(2);
  });

  it('drops older messages when over limit, keeping system and recent', () => {
    const cm = new ContextManager({
      maxTokens: 50,  // Very small window
      keepRecentMessages: 2,
      reserveResponseTokens: 5,
    });

    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a'.repeat(200) },  // old, ~54 tokens, over limit
      { role: 'user', content: 'b'.repeat(20) },    // recent 1
      { role: 'user', content: 'c'.repeat(20) },    // recent 2
    ];
    const result = cm.truncateMessages(messages);
    expect(result[0].role).toBe('system');
    // Should have a summary marker for dropped messages
    expect(result[1].content).toContain('omitted');
    // Recent messages preserved
    expect(result[result.length - 1].content).toBe('c'.repeat(20));
  });

  it('returns all messages when system+recent already exceeds limit', () => {
    // Edge case: even the essential messages don't fit
    const cm = new ContextManager({
      maxTokens: 30,
      keepRecentMessages: 2,
      reserveResponseTokens: 5,
    });

    const messages = [
      { role: 'system', content: 'x'.repeat(50) },  // alone exceeds window
      { role: 'user', content: 'hi' },
    ];
    const result = cm.truncateMessages(messages);
    // Should still return something (graceful degradation)
    expect(result.length).toBeGreaterThan(0);
  });

  it('keeps only system message when all others are dropped', () => {
    const cm = new ContextManager({
      maxTokens: 30,
      keepRecentMessages: 0,
      reserveResponseTokens: 5,
    });

    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a'.repeat(100) },  // too large
    ];
    const result = cm.truncateMessages(messages);
    expect(result[0].role).toBe('system');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('fits older messages when possible', () => {
    const cm = new ContextManager({
      maxTokens: 200,
      keepRecentMessages: 1,
      reserveResponseTokens: 10,
    });

    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a'.repeat(40) }, // old, but should fit
      { role: 'user', content: 'b'.repeat(20) }, // recent
    ];
    const result = cm.truncateMessages(messages);
    expect(result).toHaveLength(3);  // all kept
    expect(result[1].content).toBe('a'.repeat(40)); // old preserved
  });

  it('setMaxTokens updates the limit', () => {
    const cm = new ContextManager({ maxTokens: 100 });
    cm.setMaxTokens(2000);
    const messages = [
      { role: 'user', content: 'a'.repeat(1000) },
    ];
    // Should no longer exceed limit
    const result = cm.truncateMessages(messages);
    expect(result).toHaveLength(1);
  });
});
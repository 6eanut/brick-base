/**
 * Provider auto-detection tests.
 */
import { describe, it, expect } from 'vitest';
import { detectProvider, isAnthropicProvider } from '../llm/detect.js';

describe('detectProvider', () => {
  it('detects Anthropic from API key prefix', () => {
    expect(detectProvider({ apiKey: 'sk-ant-abc123' })).toBe('anthropic');
  });

  it('detects OpenAI from project API key prefix', () => {
    expect(detectProvider({ apiKey: 'sk-proj-abc123' })).toBe('openai');
  });

  it('detects OpenAI from standard API key prefix', () => {
    expect(detectProvider({ apiKey: 'sk-regular-key' })).toBe('openai');
  });

  it('detects Google from AIza prefix', () => {
    expect(detectProvider({ apiKey: 'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz' })).toBe('google');
  });

  it('detects Anthropic from model name', () => {
    expect(detectProvider({ model: 'claude-sonnet-4-20260506' })).toBe('anthropic');
  });

  it('detects OpenAI from model name', () => {
    expect(detectProvider({ model: 'gpt-4o' })).toBe('openai');
    expect(detectProvider({ model: 'o3-mini' })).toBe('openai');
  });

  it('detects Google from model name', () => {
    expect(detectProvider({ model: 'gemini-2.5-pro' })).toBe('google');
  });

  it('detects DeepSeek from model name', () => {
    expect(detectProvider({ model: 'deepseek-chat' })).toBe('deepseek');
  });

  it('detects Anthropic from base URL', () => {
    expect(detectProvider({ baseUrl: 'https://api.anthropic.com' })).toBe('anthropic');
  });

  it('detects OpenAI from base URL', () => {
    expect(detectProvider({ baseUrl: 'https://api.openai.com/v1' })).toBe('openai');
  });

  it('respects explicit provider override', () => {
    expect(detectProvider({
      explicit: 'anthropic',
      apiKey: 'sk-proj-abc', // would normally be OpenAI
    })).toBe('anthropic');
  });

  it('returns null when no clues match', () => {
    expect(detectProvider({})).toBeNull();
  });

  it('handles invalid explicit provider gracefully', () => {
    expect(detectProvider({ explicit: 'unknown-provider' })).toBeNull();
  });
});

describe('isAnthropicProvider', () => {
  it('returns true for anthropic', () => {
    expect(isAnthropicProvider('anthropic')).toBe(true);
  });

  it('returns false for other providers', () => {
    expect(isAnthropicProvider('openai')).toBe(false);
    expect(isAnthropicProvider('google')).toBe(false);
    expect(isAnthropicProvider('deepseek')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAnthropicProvider(null)).toBe(false);
  });
});
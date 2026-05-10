/**
 * ModelRegistry tests.
 *
 * Covers: registration, lookup, provider filtering, defaults.
 */
import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '../llm/models.js';

describe('ModelRegistry', () => {
  it('registers defaults on construction', () => {
    const registry = new ModelRegistry();
    const all = registry.listAll();
    expect(all.length).toBeGreaterThan(0);
  });

  it('looks up a model by name', () => {
    const registry = new ModelRegistry();
    const model = registry.get('gpt-4o');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('openai');
  });

  it('returns undefined for unknown model name', () => {
    const registry = new ModelRegistry();
    expect(registry.get('unknown-model')).toBeUndefined();
  });

  it('registers a custom model', () => {
    const registry = new ModelRegistry();
    registry.register({
      name: 'custom-model',
      provider: 'custom',
      modelId: 'custom/v1',
      maxTokens: 8192,
      supportsTools: false,
      supportsVision: false,
      supportsThinking: false,
    });
    expect(registry.get('custom-model')).toBeDefined();
  });

  it('finds models by provider', () => {
    const registry = new ModelRegistry();
    const openaiModels = registry.findByProvider('openai');
    expect(openaiModels.length).toBeGreaterThan(0);
    expect(openaiModels.every(m => m.provider === 'openai')).toBe(true);
  });

  it('returns empty array for unknown provider', () => {
    const registry = new ModelRegistry();
    expect(registry.findByProvider('nonexistent')).toEqual([]);
  });

  it('finds default model for a provider', () => {
    const registry = new ModelRegistry();
    const defaultModel = registry.getDefault('openai');
    expect(defaultModel).toBeDefined();
    expect(defaultModel?.isDefault).toBe(true);
    expect(defaultModel?.name).toBe('gpt-4o');
  });

  it('returns undefined getDefault when no default exists', () => {
    const registry = new ModelRegistry();
    expect(registry.getDefault('nonexistent')).toBeUndefined();
  });

  it('claude-sonnet-4 is default for anthropic', () => {
    const registry = new ModelRegistry();
    const defaultModel = registry.getDefault('anthropic');
    expect(defaultModel?.name).toBe('claude-sonnet-4');
  });

  it('gemini-2.5-pro is default for google', () => {
    const registry = new ModelRegistry();
    const defaultModel = registry.getDefault('google');
    expect(defaultModel?.name).toBe('gemini-2.5-pro');
  });

  it('deepseek-v3 is default for deepseek', () => {
    const registry = new ModelRegistry();
    const defaultModel = registry.getDefault('deepseek');
    expect(defaultModel?.name).toBe('deepseek-v3');
  });
});
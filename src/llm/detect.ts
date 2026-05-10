/**
 * Provider auto-detection.
 *
 * Infers the LLM provider from available clues: API key prefix, model name,
 * and base URL. This lets users omit `--provider` — just provide an API key
 * or model name and Brick figures out the rest.
 *
 * Detection priority (first match wins):
 * 1. Explicit `provider` override
 * 2. API key prefix patterns
 * 3. Model name prefix patterns
 * 4. Base URL hostname patterns
 * 5. Fallback default
 */

export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'ollama';

interface DetectOptions {
  /** Explicitly specified provider name */
  explicit?: string;
  /** API key string */
  apiKey?: string;
  /** Model name */
  model?: string;
  /** Base URL */
  baseUrl?: string;
}

// ─── API key prefix patterns ────────────────────────────────────────────

const API_KEY_PATTERNS: Array<{ prefix: string; provider: ProviderKind }> = [
  // Anthropic keys: sk-ant-...
  { prefix: 'sk-ant-', provider: 'anthropic' },
  // OpenAI project keys: sk-proj-...
  { prefix: 'sk-proj-', provider: 'openai' },
  // OpenAI standard keys: sk-... (but not sk-ant-)
  { prefix: 'sk-', provider: 'openai' },
  // Google AI keys: AIza...
  { prefix: 'AIza', provider: 'google' },
  // DeepSeek keys: sk-... (same prefix as OpenAI, less reliable — check model too)
];

// ─── Model name prefix patterns ─────────────────────────────────────────

const MODEL_PATTERNS: Array<{ prefix: string; provider: ProviderKind }> = [
  { prefix: 'claude-', provider: 'anthropic' },
  { prefix: 'gpt-', provider: 'openai' },
  { prefix: 'o1-', provider: 'openai' },
  { prefix: 'o3-', provider: 'openai' },
  { prefix: 'gemini-', provider: 'google' },
  { prefix: 'deepseek-', provider: 'deepseek' },
  { prefix: 'command-', provider: 'openai' }, // Cohere via OpenAI-compatible API
];

// ─── Base URL hostname patterns ─────────────────────────────────────────

const URL_PATTERNS: Array<{ hostname: string; provider: ProviderKind }> = [
  { hostname: 'api.anthropic.com', provider: 'anthropic' },
  { hostname: 'api.openai.com', provider: 'openai' },
  { hostname: 'generativelanguage.googleapis.com', provider: 'google' },
  { hostname: 'api.deepseek.com', provider: 'deepseek' },
];

/**
 * Detect the LLM provider from available clues.
 * Returns null if no provider can be determined.
 */
export function detectProvider(options: DetectOptions): ProviderKind | null {
  // 1. Explicit override
  if (options.explicit) {
    const normalized = options.explicit.toLowerCase().trim();
    const valid: ProviderKind[] = ['openai', 'anthropic', 'google', 'deepseek', 'ollama'];
    if (valid.includes(normalized as ProviderKind)) {
      return normalized as ProviderKind;
    }
  }

  // 2. API key patterns
  if (options.apiKey) {
    for (const { prefix, provider } of API_KEY_PATTERNS) {
      if (options.apiKey.startsWith(prefix)) {
        return provider;
      }
    }
  }

  // 3. Model name patterns
  if (options.model) {
    const model = options.model.toLowerCase();
    for (const { prefix, provider } of MODEL_PATTERNS) {
      if (model.startsWith(prefix)) {
        return provider;
      }
    }
  }

  // 4. Base URL hostname
  if (options.baseUrl) {
    try {
      const hostname = new URL(options.baseUrl).hostname;
      for (const { hostname: pattern, provider } of URL_PATTERNS) {
        if (hostname === pattern || hostname.endsWith('.' + pattern)) {
          return provider;
        }
      }
    } catch {
      // Invalid URL — ignore
    }
  }

  // 5. Nothing matched
  return null;
}

/**
 * Determine if a provider name string maps to the Anthropic provider.
 * Handles both raw detection results and user-provided names.
 */
export function isAnthropicProvider(provider: string | ProviderKind | null): boolean {
  return provider === 'anthropic';
}
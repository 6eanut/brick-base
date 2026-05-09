/**
 * Model registry.
 *
 * Maps model names (like "claude-sonnet-4", "gpt-4o") to provider configurations,
 * capabilities, and defaults.
 */

export interface ModelInfo {
  /** Display name */
  name: string;
  /** Provider that serves this model */
  provider: string;
  /** Model identifier for the API */
  modelId: string;
  /** Maximum context window */
  maxTokens: number;
  /** Whether tool calling is supported */
  supportsTools: boolean;
  /** Whether vision is supported */
  supportsVision: boolean;
  /** Whether thinking/reasoning is supported */
  supportsThinking: boolean;
  /** Whether this is the recommended default for its provider */
  isDefault?: boolean;
}

export class ModelRegistry {
  private models: Map<string, ModelInfo> = new Map();

  constructor() {
    this.registerDefaults();
  }

  register(model: ModelInfo): void {
    this.models.set(model.name, model);
  }

  get(name: string): ModelInfo | undefined {
    return this.models.get(name);
  }

  findByProvider(provider: string): ModelInfo[] {
    return Array.from(this.models.values()).filter(m => m.provider === provider);
  }

  getDefault(provider: string): ModelInfo | undefined {
    return this.findByProvider(provider).find(m => m.isDefault);
  }

  listAll(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  private registerDefaults(): void {
    // OpenAI
    this.register({
      name: 'gpt-4o',
      provider: 'openai',
      modelId: 'gpt-4o',
      maxTokens: 128_000,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: false,
      isDefault: true,
    });
    this.register({
      name: 'o3-mini',
      provider: 'openai',
      modelId: 'o3-mini',
      maxTokens: 200_000,
      supportsTools: true,
      supportsVision: false,
      supportsThinking: true,
    });

    // Anthropic
    this.register({
      name: 'claude-sonnet-4',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      maxTokens: 200_000,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
      isDefault: true,
    });
    this.register({
      name: 'claude-haiku-3.5',
      provider: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      maxTokens: 200_000,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: false,
    });

    // Google
    this.register({
      name: 'gemini-2.5-pro',
      provider: 'google',
      modelId: 'gemini-2.5-pro',
      maxTokens: 1_000_000,
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
      isDefault: true,
    });

    // DeepSeek
    this.register({
      name: 'deepseek-v3',
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      maxTokens: 128_000,
      supportsTools: true,
      supportsVision: false,
      supportsThinking: false,
      isDefault: true,
    });
  }
}
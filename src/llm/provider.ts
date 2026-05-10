/**
 * LLM Provider abstraction layer.
 *
 * Defines a common interface for all LLM providers (OpenAI, Anthropic, Google, etc.)
 * so the agent loop never depends on a specific provider's SDK.
 */

export interface ProviderCapabilities {
  /** Maximum context window size in tokens */
  maxTokens: number;
  /** Whether the provider supports streaming */
  streaming: boolean;
  /** Whether the provider supports tool/function calling */
  toolCalling: boolean;
  /** Whether the provider supports vision/image inputs */
  vision: boolean;
  /** Whether the provider supports thinking/reasoning tokens */
  thinking: boolean;
}

export interface ProviderConfig {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  capabilities?: Partial<ProviderCapabilities>;
}

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  thinking?: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Common interface for all LLM providers.
 * Both OpenAI-compatible and Anthropic providers implement this.
 */
export interface Provider {
  readonly name: string;
  readonly defaultModel: string | undefined;
  getCapabilities(): ProviderCapabilities;
  chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMToolDefinition[];
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<LLMResponse>;
}

export class LLMProvider implements Provider {
  private config: ProviderConfig;
  private capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.capabilities = {
      maxTokens: 128_000,
      streaming: true,
      toolCalling: true,
      vision: false,
      thinking: false,
      ...config.capabilities,
    };
  }

  get name(): string {
    return this.config.name;
  }

  get defaultModel(): string | undefined {
    return this.config.defaultModel;
  }

  getCapabilities(): ProviderCapabilities {
    return { ...this.capabilities };
  }

  /**
   * Send a chat completion request to the LLM provider.
   * Uses the OpenAI-compatible API format (works with OpenAI, LiteLLM proxy, etc.)
   */
  async chat(
    messages: LLMMessage[],
    options?: {
      model?: string;
      tools?: LLMToolDefinition[];
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.config.defaultModel ?? 'unknown';
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? this.capabilities.maxTokens,
    };

    if (options?.tools && options.tools.length > 0 && this.capabilities.toolCalling) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey ?? ''}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    const choice = data.choices[0];
    return {
      content: choice.message.content ?? '',
      toolCalls: (choice.message.tool_calls ?? []).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
    };
  }
}
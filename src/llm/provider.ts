/**
 * LLM Provider abstraction layer.
 *
 * Defines a common interface for all LLM providers (OpenAI, Anthropic, Google, etc.)
 * so the agent loop never depends on a specific provider's SDK.
 */

import { parseSseStream } from './sse-parser.js';

/** Strips trailing slashes to prevent double-slash when joining with API paths. */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

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

export interface MessageImage {
  /** Base64-encoded image data */
  data: string;
  /** MIME type, e.g. "image/jpeg", "image/png", "image/webp" */
  mediaType: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** Tool calls made by the assistant (only on role='assistant' messages) */
  toolCalls?: ToolCallRequest[];
  /** Optional image attachments (for vision-capable providers) */
  images?: MessageImage[];
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Options for a chat completion request.
 *
 * All fields are optional — providers use sensible defaults.
 * When `onToken` is provided, the provider SHOULD stream tokens
 * in real-time via the callback while still returning the full
 * accumulated response.
 */
export interface ChatOptions {
  model?: string;
  tools?: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Called for each text token during streaming */
  onToken?: (token: string) => void;
  /** Called for each thinking/reasoning token during streaming (Anthropic) */
  onThinkingToken?: (token: string) => void;
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
    options?: ChatOptions,
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
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.config.defaultModel ?? 'unknown';
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => {
        const msg: Record<string, unknown> = {
          role: m.role,
        };
        if (m.toolCallId) {
          msg.tool_call_id = m.toolCallId;
        }

        // Include tool_calls on assistant messages for tool round-trip
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
        }

        // Handle vision/multimodal: when images are present, content becomes
        // an array of text + image_url parts (OpenAI format).
        // See: https://platform.openai.com/docs/guides/vision
        if (m.images && m.images.length > 0 && this.capabilities.vision) {
          const content: Array<Record<string, unknown>> = [];
          if (m.content) {
            content.push({ type: 'text', text: m.content });
          }
          for (const img of m.images) {
            content.push({
              type: 'image_url',
              image_url: {
                url: `data:${img.mediaType};base64,${img.data}`,
              },
            });
          }
          msg.content = content;
        } else {
          msg.content = m.content;
        }

        return msg;
      }),
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

    const isStreaming = !!options?.onToken;
    if (isStreaming) {
      body.stream = true;
    }

    const baseUrl = normalizeBaseUrl(this.config.baseUrl ?? 'https://api.openai.com/v1');
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

    // ─── Streaming path ────────────────────────────────────────────────
    if (isStreaming) {
      return this.streamChat(response, options);
    }

    // ─── Non-streaming path ────────────────────────────────────────────
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

  /**
   * Stream a chat completion response, emitting tokens via onToken/onThinkingToken.
   *
   * Parses the OpenAI streaming format:
   *   data: {"choices":[{"delta":{"content":"hello"},"index":0}]}
   *
   * Tool calls arrive incrementally by delta.index and must be accumulated.
   */
  private async streamChat(response: Response, options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.config.defaultModel ?? 'unknown';
    let content = '';
    const toolCalls: ToolCallRequest[] = [];
    const onToken = options?.onToken;
    let malformedChunks = 0;

    for await (const event of parseSseStream(response)) {
      // OpenAI end-of-stream sentinel
      if (event.data === '[DONE]') break;

      let parsed: { choices?: Array<{ delta: Record<string, unknown>; finish_reason?: string | null }> };
      try {
        parsed = JSON.parse(event.data);
      } catch {
        malformedChunks++;
        if (malformedChunks >= 3) {
          throw new Error(
            `Stream corrupted: ${malformedChunks} malformed chunks received. ` +
            `Last raw data: ${event.data.slice(0, 200)}`,
          );
        }
        continue;
      }

      if (!parsed.choices || parsed.choices.length === 0) continue;

      const delta = parsed.choices[0].delta ?? {};

      // Text content delta
      if (typeof delta.content === 'string') {
        content += delta.content;
        onToken?.(delta.content);
      }

      // Tool call deltas — arrive incrementally by index
      const toolCallDeltas = delta.tool_calls as
        | Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
        | undefined;

      if (toolCallDeltas) {
        for (const tc of toolCallDeltas) {
          // Ensure we have a slot for this index
          while (toolCalls.length <= tc.index) {
            toolCalls.push({
              id: '',
              type: 'function',
              function: { name: '', arguments: '' },
            });
          }

          if (tc.id) toolCalls[tc.index].id = tc.id;
          if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
        }
      }
    }

    return {
      content,
      toolCalls: toolCalls.filter(tc => tc.id !== ''), // Remove empty slots
      model,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
}
/**
 * Anthropic LLM Provider.
 *
 * Bridges Brick's LLM abstraction layer with the Anthropic Messages API.
 * Supports Claude models (Sonnet, Opus, Haiku) with tool calling and thinking.
 *
 * Key differences from the OpenAI-compatible path:
 * - Authentication uses x-api-key header instead of Authorization: Bearer
 * - System prompt is a separate `system` parameter, not a message role
 * - Tool calls are content blocks (type "tool_use") rather than a separate array
 * - Tool results are content blocks (type "tool_result") within user messages
 * - Thinking/reasoning comes as content blocks (type "thinking")
 */

import {
  type ChatOptions,
  type Provider,
  type ProviderConfig,
  type ProviderCapabilities,
  type LLMMessage,
  type LLMResponse,
  type LLMToolDefinition,
  type ToolCallRequest,
} from './provider.js';
import { parseSseStream } from './sse-parser.js';

// ─── Anthropic API types ────────────────────────────────────────────────────

interface AnthropicContentBlockText {
  type: 'text';
  text: string;
}

interface AnthropicContentBlockThinking {
  type: 'thinking';
  thinking: string;
}

interface AnthropicContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockThinking
  | AnthropicContentBlockToolUse;

/** Content blocks allowed inside user messages (includes tool_result). */
type AnthropicUserContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockToolResult;

type AnthropicMessageRole = 'user' | 'assistant';

interface AnthropicMessage {
  role: AnthropicMessageRole;
  content: string | AnthropicContentBlock[] | AnthropicUserContentBlock[];
}

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicApiRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  tools?: AnthropicToolDefinition[];
  thinking?: { type: 'enabled'; budget_tokens: number };
  stream?: boolean;
}

interface AnthropicApiResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ─── Supported Claude models ────────────────────────────────────────────────

const CLAUDE_MODELS = [
  'claude-sonnet-4-20260506',
  'claude-opus-4-20260506',
  'claude-haiku-4-20260506',
] as const;

const DEFAULT_MODEL = 'claude-sonnet-4-20260506';
const DEFAULT_MAX_TOKENS = 8192;
const THINKING_BUDGET_TOKENS = 16000;

// ─── AnthropicProvider ──────────────────────────────────────────────────────

export class AnthropicProvider implements Provider {
  private config: ProviderConfig;
  private capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.capabilities = {
      maxTokens: 200_000,
      streaming: true,
      toolCalling: true,
      vision: true,
      thinking: true,
      ...config.capabilities,
    };
  }

  get name(): string {
    return this.config.name;
  }

  get defaultModel(): string | undefined {
    return this.config.defaultModel ?? DEFAULT_MODEL;
  }

  getCapabilities(): ProviderCapabilities {
    return { ...this.capabilities };
  }

  /**
   * Send a chat completion request to the Anthropic Messages API.
   * Handles all format conversions between Brick's LLM message format
   * and Anthropic's native format.
   */
  async chat(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.config.defaultModel ?? DEFAULT_MODEL;

    // Convert messages to Anthropic format
    const { system, anthropicMessages } = this.toAnthropicMessages(messages);

    // Build request body
    const body: AnthropicApiRequest = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: options?.temperature ?? 0.7,
    };

    if (system) {
      body.system = system;
    }

    if (options?.tools && options.tools.length > 0 && this.capabilities.toolCalling) {
      body.tools = options.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    // Enable thinking if we have enough max_tokens headroom
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (this.capabilities.thinking && maxTokens > THINKING_BUDGET_TOKENS) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: THINKING_BUDGET_TOKENS,
      };
    }

    const isStreaming = !!options?.onToken;
    if (isStreaming) {
      body.stream = true;
    }

    // Make API request
    const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com';
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    // ─── Streaming path ────────────────────────────────────────────────
    if (isStreaming) {
      return this.streamChat(response, options, model);
    }

    // ─── Non-streaming path ────────────────────────────────────────────
    const data = (await response.json()) as AnthropicApiResponse;

    return this.toLLMResponse(data, model);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Convert Brick's LLMMessage array to Anthropic's message format.
   *
   * Rules:
   * - System messages are extracted and concatenated into a single `system` string.
   * - Tool messages are grouped: preceded by a synthetic assistant message with
   *   tool_use content blocks, then converted to user messages with tool_result blocks.
   * - User and assistant messages map directly.
   */
  private toAnthropicMessages(messages: LLMMessage[]): {
    system: string;
    anthropicMessages: AnthropicMessage[];
  } {
    // Extract system messages
    const systemParts: string[] = [];
    const nonSystemMessages = messages.filter(m => {
      if (m.role === 'system') {
        systemParts.push(m.content);
        return false;
      }
      return true;
    });

    const anthropicMessages: AnthropicMessage[] = [];
    let i = 0;

    while (i < nonSystemMessages.length) {
      const msg = nonSystemMessages[i];

      if (msg.role === 'user') {
        anthropicMessages.push({ role: 'user', content: msg.content });
        i++;
        continue;
      }

      if (msg.role === 'assistant') {
        // Look ahead for consecutive tool messages
        const toolMessages: LLMMessage[] = [];
        let j = i + 1;
        while (j < nonSystemMessages.length && nonSystemMessages[j].role === 'tool') {
          toolMessages.push(nonSystemMessages[j]);
          j++;
        }

        if (toolMessages.length > 0) {
          // Build assistant content blocks: text + tool_use blocks
          const blocks: AnthropicContentBlock[] = [];
          if (msg.content) {
            blocks.push({ type: 'text', text: msg.content });
          }
          for (const tm of toolMessages) {
            blocks.push({
              type: 'tool_use',
              id: tm.toolCallId ?? crypto.randomUUID(),
              name: tm.toolName ?? 'unknown',
              input: {},
            });
          }
          anthropicMessages.push({ role: 'assistant', content: blocks });

          // Tool results become user messages with tool_result content blocks
          for (const tm of toolMessages) {
            anthropicMessages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: tm.toolCallId ?? '',
                  content: tm.content,
                },
              ],
            });
          }

          i = j; // Skip processed tool messages
        } else {
          // Plain text assistant message
          anthropicMessages.push({ role: 'assistant', content: msg.content });
          i++;
        }

        continue;
      }

      // Skip any remaining tool messages (should not reach here)
      i++;
    }

    return {
      system: systemParts.join('\n'),
      anthropicMessages,
    };
  }

  /**
   * Convert an Anthropic API response to Brick's LLMResponse format.
   */
  private toLLMResponse(data: AnthropicApiResponse, model: string): LLMResponse {
    let textContent = '';
    let thinkingContent: string | undefined;
    const toolCalls: ToolCallRequest[] = [];

    for (const block of data.content) {
      switch (block.type) {
        case 'text':
          textContent = block.text;
          break;

        case 'thinking':
          thinkingContent = block.thinking;
          break;

        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
      }
    }

    return {
      content: textContent,
      toolCalls,
      model: data.model,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      thinking: thinkingContent,
    };
  }

  // ─── Streaming ──────────────────────────────────────────────────────

  /**
   * Stream a chat completion response from the Anthropic API.
   *
   * Anthropic's streaming format uses named events:
   *   event: content_block_delta
   *   data: {"type":"content_block_delta","index":0,"delta":{"text":"hello"}}
   *
   * Each content block (text, thinking, tool_use) has its own lifecycle:
   *   content_block_start → (multiple content_block_delta) → content_block_stop
   */
  private async streamChat(
    response: Response,
    options: ChatOptions | undefined,
    model: string,
  ): Promise<LLMResponse> {
    let content = '';
    let thinkingContent: string | undefined;
    const toolCalls: ToolCallRequest[] = [];
    const onToken = options?.onToken;
    const onThinkingToken = options?.onThinkingToken;
    let inputTokens = 0;
    let outputTokens = 0;
    let resolvedModel = model;

    // Track block types by index to route deltas correctly
    const blockTypes = new Map<number, 'text' | 'thinking' | 'tool_use'>();

    // Accumulate tool_use blocks by index
    const inboundToolCalls = new Map<number, ToolCallRequest>();

    // Track malformed chunks for error detection
    let malformedChunks = 0;

    for await (const event of parseSseStream(response)) {
      switch (event.event) {
        case 'message_start': {
          // Extract model name and input token usage from the message
          // data: {"type":"message_start","message":{"id":"...","model":"claude-sonnet-4-20260506","usage":{"input_tokens":100}}}
          try {
            const msgData = JSON.parse(event.data) as {
              type: string;
              message: { model?: string; usage: { input_tokens: number } };
            };
            if (msgData.message?.model) {
              resolvedModel = msgData.message.model;
            }
            inputTokens = msgData.message?.usage?.input_tokens ?? 0;
          } catch {
            malformedChunks++;
            if (malformedChunks >= 3) {
              throw new Error(
                `Anthropic stream corrupted: ${malformedChunks} malformed chunks received`,
              );
            }
          }
          break;
        }

        case 'content_block_start': {
          // data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
          // data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}
          // data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"...","name":"...","input":{}}}
          let blockData: { type: string; [key: string]: unknown };
          try {
            blockData = JSON.parse(event.data);
          } catch {
            malformedChunks++;
            if (malformedChunks >= 3) {
              throw new Error(
                `Anthropic stream corrupted: ${malformedChunks} malformed chunks received`,
              );
            }
            continue;
          }
          const block = blockData.content_block as { type: string; [key: string]: unknown } | undefined;
          if (!block) continue;

          const index = blockData.index as number;
          blockTypes.set(index, block.type as 'text' | 'thinking' | 'tool_use');

          if (block.type === 'tool_use') {
            inboundToolCalls.set(index, {
              id: block.id as string,
              type: 'function',
              function: {
                name: block.name as string,
                arguments: '',
              },
            });
          }
          break;
        }

        case 'content_block_delta': {
          // data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}
          // data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"..."}}
          let deltaData: { index: number; delta: { type: string; [key: string]: unknown } };
          try {
            deltaData = JSON.parse(event.data);
          } catch {
            malformedChunks++;
            if (malformedChunks >= 3) {
              throw new Error(
                `Anthropic stream corrupted: ${malformedChunks} malformed chunks received`,
              );
            }
            continue;
          }

          const { index, delta } = deltaData;
          const blockType = blockTypes.get(index);

          if (delta.type === 'text_delta' && blockType === 'text') {
            const text = delta.text as string;
            content += text;
            onToken?.(text);
          } else if (delta.type === 'thinking_delta' && blockType === 'thinking') {
            const thinking = delta.thinking as string;
            if (!thinkingContent) thinkingContent = '';
            thinkingContent += thinking;
            onThinkingToken?.(thinking);
          } else if (delta.type === 'input_json_delta' && blockType === 'tool_use') {
            const partial = delta.partial_json as string;
            const existing = inboundToolCalls.get(index);
            if (existing) {
              existing.function.arguments += partial;
            }
          }
          break;
        }

        case 'content_block_stop': {
          // Finalize tool call at this index
          // data: {"type":"content_block_stop","index":0}
          let stopData: { index: number };
          try {
            stopData = JSON.parse(event.data);
          } catch {
            malformedChunks++;
            if (malformedChunks >= 3) {
              throw new Error(
                `Anthropic stream corrupted: ${malformedChunks} malformed chunks received`,
              );
            }
            continue;
          }
          const tc = inboundToolCalls.get(stopData.index);
          if (tc) {
            // Shallow-copy to prevent mutation if a stray delta arrives later
            toolCalls.push({
              ...tc,
              function: { ...tc.function },
            });
            inboundToolCalls.delete(stopData.index);
          }
          break;
        }

        case 'message_delta': {
          // data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}
          try {
            const deltaData = JSON.parse(event.data) as {
              type: string;
              usage: { output_tokens: number };
            };
            outputTokens = deltaData.usage?.output_tokens ?? 0;
          } catch {
            malformedChunks++;
            if (malformedChunks >= 3) {
              throw new Error(
                `Anthropic stream corrupted: ${malformedChunks} malformed chunks received`,
              );
            }
          }
          break;
        }

        case 'ping':
          // Keepalive — ignore
          break;
      }
    }

    return {
      content,
      toolCalls,
      model: resolvedModel,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      thinking: thinkingContent,
    };
  }
}
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
  type Provider,
  type ProviderConfig,
  type ProviderCapabilities,
  type LLMMessage,
  type LLMResponse,
  type LLMToolDefinition,
  type ToolCallRequest,
} from './provider.js';

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
    options?: {
      model?: string;
      tools?: LLMToolDefinition[];
      temperature?: number;
      maxTokens?: number;
    },
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
}
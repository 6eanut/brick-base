/**
 * Google Gemini LLM Provider.
 *
 * Bridges Brick's LLM abstraction layer with the Google Gemini API.
 * Supports Gemini 2.5 Pro and other Gemini models.
 *
 * Key differences from OpenAI-compatible providers:
 * - API key passed as query parameter (?key=...), not in headers
 * - Messages use "contents" with "parts" array instead of "messages"
 * - Tool calls use "functionCall" / "functionResponse" part types
 * - Streaming via ?alt=sse or streamGenerateContent endpoint
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

// ─── Google Gemini API types ────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

interface GeminiApiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: [{ text: string }] };
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
}

interface GeminiApiResponseCandidate {
  content: GeminiContent;
  finishReason?: string;
}

interface GeminiApiResponse {
  candidates: GeminiApiResponseCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// ─── Supported Gemini models ────────────────────────────────────────────

const GEMINI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
] as const;

const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_MAX_TOKENS = 8192;

// ─── GoogleProvider ────────────────────────────────────────────────────

export class GoogleProvider implements Provider {
  private config: ProviderConfig;
  private capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.capabilities = {
      maxTokens: 1_000_000,
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

  async chat(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.config.defaultModel ?? DEFAULT_MODEL;

    // Convert Brick messages to Gemini format
    const { systemInstruction, contents } = this.toGeminiMessages(messages);

    // Build request body
    const body: GeminiApiRequest = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (options?.tools && options.tools.length > 0 && this.capabilities.toolCalling) {
      body.tools = [
        {
          functionDeclarations: options.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }

    const isStreaming = !!options?.onToken;
    const baseUrl = this.config.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const apiKey = this.config.apiKey ?? '';

    // Use streaming endpoint or regular
    const endpoint = isStreaming
      ? `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
      : `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    if (isStreaming) {
      return this.streamChat(response, options, model);
    }

    const data = (await response.json()) as GeminiApiResponse;
    return this.toLLMResponse(data, model);
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private toGeminiMessages(messages: LLMMessage[]): {
    systemInstruction: string;
    contents: GeminiContent[];
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

    const contents: GeminiContent[] = [];
    let i = 0;

    while (i < nonSystemMessages.length) {
      const msg = nonSystemMessages[i];

      if (msg.role === 'user') {
        // Check if this is a tool_result — wrap in functionResponse
        if (msg.toolCallId) {
          contents.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: msg.toolName ?? 'unknown',
                  response: { output: msg.content },
                },
              },
            ],
          });
          i++;
          continue;
        }
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
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

        const parts: GeminiPart[] = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        for (const tm of toolMessages) {
          parts.push({
            functionCall: {
              name: tm.toolName ?? 'unknown',
              args: {},
            },
          });
        }
        contents.push({ role: 'model', parts });
        i = j > i + 1 ? j : i + 1;
        continue;
      }

      // Tool messages without preceding assistant — should not happen
      if (msg.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.toolName ?? 'unknown',
                response: { output: msg.content },
              },
            },
          ],
        });
        i++;
        continue;
      }

      i++;
    }

    return {
      systemInstruction: systemParts.join('\n'),
      contents,
    };
  }

  private toLLMResponse(data: GeminiApiResponse, model: string): LLMResponse {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      return {
        content: '',
        toolCalls: [],
        model,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    let textContent = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        textContent += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `fc_${part.functionCall.name}_${Date.now()}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        });
      }
    }

    const usage = data.usageMetadata ?? { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

    return {
      content: textContent,
      toolCalls,
      model,
      usage: {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
      },
    };
  }

  private async streamChat(
    response: Response,
    options: ChatOptions | undefined,
    model: string,
  ): Promise<LLMResponse> {
    let content = '';
    const toolCalls: ToolCallRequest[] = [];
    const onToken = options?.onToken;
    let inputTokens = 0;
    let outputTokens = 0;
    let malformedChunks = 0;

    for await (const event of parseSseStream(response)) {
      // Skip keepalive comments
      if (event.data.trim() === '' || event.data.startsWith('[')) continue;

      let parsed: GeminiApiResponse;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        malformedChunks++;
        if (malformedChunks >= 3) {
          throw new Error(
            `Gemini stream corrupted: ${malformedChunks} malformed chunks received`,
          );
        }
        continue;
      }

      const candidate = parsed.candidates?.[0];
      if (!candidate) continue;

      const parts = candidate.content?.parts ?? [];
      for (const part of parts) {
        if (part.text) {
          content += part.text;
          onToken?.(part.text);
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `fc_${part.functionCall.name}_${Date.now()}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args),
            },
          });
        }
      }

      // Capture token usage from the last chunk
      if (parsed.usageMetadata) {
        inputTokens = parsed.usageMetadata.promptTokenCount;
        outputTokens = parsed.usageMetadata.candidatesTokenCount;
      }
    }

    return {
      content,
      toolCalls,
      model,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }
}
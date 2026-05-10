/**
 * Provider tests.
 *
 * Tests all three LLM providers (LLMProvider/OpenAI, AnthropicProvider, GoogleProvider)
 * with mocked fetch responses. Covers:
 * - Basic chat (non-streaming)
 * - Streaming chat with token emission
 * - Tool calling
 * - Vision/multimodal (images in messages)
 * - Error handling
 * - Message format conversion
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LLMProvider } from '../llm/provider.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { GoogleProvider } from '../llm/google.js';
import type { LLMMessage } from '../llm/provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal mock Response with a text body. */
function mockResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

/** Create a streaming mock Response from string chunks. */
function mockStreamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status });
}

// ─── Test data ─────────────────────────────────────────────────────────────────

const OPENAI_CHAT_RESPONSE = JSON.stringify({
  choices: [{ message: { content: 'Hello from OpenAI!' }, index: 0 }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  model: 'gpt-4o',
});

const OPENAI_TOOL_RESPONSE = JSON.stringify({
  choices: [{
    message: {
      content: null,
      tool_calls: [{
        id: 'call_abc123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
      }],
    },
    index: 0,
  }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  model: 'gpt-4o',
});

const ANTHROPIC_CHAT_RESPONSE = JSON.stringify({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello from Claude!' }],
  model: 'claude-sonnet-4-20260506',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const ANTHROPIC_TOOL_RESPONSE = JSON.stringify({
  id: 'msg_2',
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'text', text: 'I will check the weather.' },
    { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Tokyo' } },
  ],
  model: 'claude-sonnet-4-20260506',
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 15 },
});

const GEMINI_CHAT_RESPONSE = JSON.stringify({
  candidates: [{
    content: { parts: [{ text: 'Hello from Gemini!' }], role: 'model' },
    finishReason: 'STOP',
  }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
});

const GEMINI_TOOL_RESPONSE = JSON.stringify({
  candidates: [{
    content: {
      parts: [
        { text: 'I will check the weather.' },
        { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } },
      ],
      role: 'model',
    },
    finishReason: 'STOP',
  }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
});

// ─── LLMProvider (OpenAI-compatible) tests ────────────────────────────────────

describe('LLMProvider (OpenAI-compatible)', () => {
  let provider: LLMProvider;

  beforeEach(() => {
    provider = new LLMProvider({
      name: 'openai',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com',
      capabilities: { vision: true },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends basic chat request and returns response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(OPENAI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('Hello from OpenAI!');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.model).toBe('gpt-4o');
  });

  it('handles tool calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(OPENAI_TOOL_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'What is the weather?' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(result.toolCalls[0].function.arguments).toBe('{"city":"Tokyo"}');
  });

  it('streams tokens via onToken callback', async () => {
    const streamData = [
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"index":0}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const tokens: string[] = [];
    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, {
      onToken: (token) => tokens.push(token),
    });

    expect(result.content).toBe('Hello world');
    expect(tokens).toEqual(['Hello', ' world']);
  });

  it('streams tool calls with delta accumulation', async () => {
    const streamData = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Tokyo\\"}"}}]},"index":0}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather?' }];
    const result = await provider.chat(messages, { onToken: () => {} });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(result.toolCalls[0].function.arguments).toBe('{"city":"Tokyo"}');
  });

  it('sends images in multipart content format', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(OPENAI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{
      role: 'user',
      content: 'What is in this image?',
      images: [{ data: 'base64data', mediaType: 'image/png' }],
    }];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    const content = body.messages[0].content;

    expect(content).toBeInstanceOf(Array);
    expect(content[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,base64data' },
    });
  });

  it('falls back to plain content when capabilities lack vision', async () => {
    const noVisionProvider = new LLMProvider({
      name: 'openai',
      apiKey: 'sk-test-key',
      capabilities: { vision: false },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(OPENAI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{
      role: 'user',
      content: 'What is in this image?',
      images: [{ data: 'base64data', mediaType: 'image/png' }],
    }];
    await noVisionProvider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    // Should be plain string, not array
    expect(typeof body.messages[0].content).toBe('string');
  });

  it('throws on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    ));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    await expect(provider.chat(messages)).rejects.toThrow('LLM API error (401)');
  });

  it('throws on stream corruption after 3 malformed chunks', async () => {
    const streamData = [
      'data: not-json\n\n',
      'data: also-not-json\n\n',
      'data: still-not-json\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    await expect(
      provider.chat(messages, { onToken: () => {} })
    ).rejects.toThrow('Stream corrupted');
  });

  it('passes tool definitions in the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(OPENAI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather?' }];
    await provider.chat(messages, {
      tools: [{
        name: 'get_weather',
        description: 'Get weather for a city',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('get_weather');
  });

  it('exposes getters for name, defaultModel, getCapabilities', () => {
    expect(provider.name).toBe('openai');
    expect(provider.defaultModel).toBeUndefined();
    const caps = provider.getCapabilities();
    expect(caps.vision).toBe(true);
    expect(caps.streaming).toBe(true);
  });

  it('handles default model in chat when none configured', async () => {
    const noModelProvider = new LLMProvider({
      name: 'test',
      apiKey: 'key',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(OPENAI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    await noModelProvider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.model).toBe('unknown');
  });
});

// ─── AnthropicProvider tests ──────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider({
      name: 'anthropic',
      apiKey: 'sk-ant-test-key',
      baseUrl: 'https://api.anthropic.com',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends basic chat request and returns response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(ANTHROPIC_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('Hello from Claude!');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('handles tool calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(ANTHROPIC_TOOL_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather?' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('I will check the weather.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(result.toolCalls[0].function.arguments).toBe('{"city":"Tokyo"}');
  });

  it('streams tokens via onToken callback', async () => {
    const streamData = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20260506","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const tokens: string[] = [];
    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, {
      onToken: (token) => tokens.push(token),
    });

    expect(result.content).toBe('Hello world');
    expect(tokens).toEqual(['Hello', ' world']);
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it('streams thinking tokens via onThinkingToken', async () => {
    const streamData = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20260506","usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about this..."}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" step by step."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is my answer."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const thinkingTokens: string[] = [];
    const messages: LLMMessage[] = [{ role: 'user', content: 'Think step by step' }];
    const result = await provider.chat(messages, {
      onThinkingToken: (token) => thinkingTokens.push(token),
    });

    expect(result.content).toBe('Here is my answer.');
    expect(result.thinking).toBe('Let me think about this... step by step.');
    expect(thinkingTokens).toEqual(['Let me think about this...', ' step by step.']);
  });

  it('sends images as content blocks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(ANTHROPIC_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{
      role: 'user',
      content: 'Describe this image',
      images: [{ data: 'base64imgdata', mediaType: 'image/png' }],
    }];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toBeInstanceOf(Array);
    const textBlock = userMsg.content.find((c: { type: string }) => c.type === 'text');
    expect(textBlock.text).toBe('Describe this image');
    const imageBlock = userMsg.content.find((c: { type: string }) => c.type === 'image');
    expect(imageBlock.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'base64imgdata',
    });
  });

  it('groups tool messages with preceding assistant message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(ANTHROPIC_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [
      { role: 'user', content: 'Weather in Tokyo?' },
      { role: 'assistant', content: 'Let me check.' },
      { role: 'tool', content: 'Sunny, 22°C', toolCallId: 'tu_1', toolName: 'get_weather' },
    ];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);

    // Should have: user + assistant(with tool_use) + user(with tool_result)
    expect(body.messages).toHaveLength(3);
    const asstMsg = body.messages[1];
    expect(asstMsg.role).toBe('assistant');
    expect(asstMsg.content).toBeInstanceOf(Array);
    const toolUseBlock = asstMsg.content.find((c: { type: string }) => c.type === 'tool_use');
    expect(toolUseBlock.name).toBe('get_weather');

    const toolResultMsg = body.messages[2];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.content[0].type).toBe('tool_result');
  });

  it('includes system prompt as separate system field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(ANTHROPIC_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.system).toBe('You are a helpful assistant.');
    // System messages should not appear in messages array
    const userMsgs = body.messages.filter((m: { role: string }) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
  });

  it('throws on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 }),
    ));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    await expect(provider.chat(messages)).rejects.toThrow('Anthropic API error (401)');
  });

  it('streams tool calls via content blocks', async () => {
    const streamData = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20260506","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Tokyo\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather?' }];
    const result = await provider.chat(messages, { onToken: () => {} });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(result.toolCalls[0].function.arguments).toBe('{"city":"Tokyo"}');
    expect(result.usage.completionTokens).toBe(15);
  });

  it('handles ping events in stream', async () => {
    const streamData = [
      'event: ping\ndata: {}\n\n',
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20260506","usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, { onToken: () => {} });

    expect(result.content).toBe('Done');
  });

  it('handles malformed JSON in stream (under threshold)', async () => {
    const streamData = [
      'event: message_start\ndata: not-json\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Works"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, { onToken: () => {} });

    expect(result.content).toBe('Works');
  });

  it('handles multiple tool calls in stream (input_json_delta)', async () => {
    const streamData = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20260506","usage":{"input_tokens":10}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Tokyo\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_2","name":"get_time","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather + time?' }];
    const result = await provider.chat(messages, { onToken: () => {} });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(result.toolCalls[1].function.name).toBe('get_time');
  });

  it('exposes getters for name, defaultModel, getCapabilities', () => {
    expect(provider.name).toBe('anthropic');
    expect(provider.defaultModel).toBe('claude-sonnet-4-20260506');
    const caps = provider.getCapabilities();
    expect(caps.maxTokens).toBe(200_000);
    expect(caps.streaming).toBe(true);
  });

  it('handles assistant message with no text content and tool messages', async () => {
    const response = JSON.stringify({
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Tokyo' } },
      ],
      model: 'claude-sonnet-4-20260506',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(response)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather?' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
  });
});

// ─── GoogleProvider tests ─────────────────────────────────────────────────────

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider({
      name: 'google',
      apiKey: 'AIza-test-key',
      baseUrl: 'https://generativelanguage.googleapis.com',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends basic chat request and returns response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(GEMINI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('Hello from Gemini!');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('handles tool calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(GEMINI_TOOL_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather?' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('I will check the weather.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
  });

  it('streams tokens via onToken callback', async () => {
    const streamData = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const tokens: string[] = [];
    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, {
      onToken: (token) => tokens.push(token),
    });

    expect(result.content).toBe('Hello world');
    expect(tokens).toEqual(['Hello', ' world']);
    expect(result.usage.completionTokens).toBe(3);
  });

  it('sends images as inlineData parts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(GEMINI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{
      role: 'user',
      content: 'What is in this image?',
      images: [{ data: 'base64img', mediaType: 'image/jpeg' }],
    }];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    const userContent = body.contents.find((c: { role: string }) => c.role === 'user');
    expect(userContent.parts).toHaveLength(2);
    expect(userContent.parts[0]).toEqual({ text: 'What is in this image?' });
    expect(userContent.parts[1]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'base64img' },
    });
  });

  it('converts tool results to functionResponse parts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(GEMINI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [
      { role: 'user', content: 'Weather in Tokyo?' },
      { role: 'assistant', content: 'Checking...' },
      { role: 'tool', content: 'Sunny, 22°C', toolCallId: 'fc_1', toolName: 'get_weather' },
    ];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);

    // Tool result should be a functionResponse part
    const toolResultContent = body.contents.find(
      (c: { role: string; parts: Array<{ functionResponse?: unknown }> }) =>
        c.parts?.[0]?.functionResponse
    );
    expect(toolResultContent).toBeDefined();
    expect(toolResultContent.parts[0].functionResponse.name).toBe('get_weather');
  });

  it('includes system instruction separate from contents', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(GEMINI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.systemInstruction).toBeDefined();
    expect(body.systemInstruction.parts[0].text).toBe('You are a helpful assistant.');
  });

  it('uses key query parameter in URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(GEMINI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('key=AIza-test-key');
    expect(url).toContain('generateContent');
  });

  it('uses streaming endpoint when onToken is provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse([])));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hello' }];
    await provider.chat(messages, { onToken: () => {} });

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('streamGenerateContent');
  });

  it('throws on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('API key not valid', { status: 403 }),
    ));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    await expect(provider.chat(messages)).rejects.toThrow('Gemini API error (403)');
  });

  it('handles empty candidates in non-streaming response', async () => {
    const emptyResponse = JSON.stringify({
      candidates: [],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(emptyResponse)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages);

    expect(result.content).toBe('');
    expect(result.toolCalls).toHaveLength(0);
  });

  it('handles function calls in streaming response', async () => {
    const streamData = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Tokyo"}}}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Weather?' }];
    const result = await provider.chat(messages, { onToken: () => {} });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('get_weather');
    expect(result.usage.completionTokens).toBe(5);
  });

  it('handles malformed chunks in Gemini stream (under threshold)', async () => {
    const streamData = [
      'data: not-valid-json\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"Works"}],"role":"model"},"finishReason":"STOP"}]}\n\n',
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockStreamResponse(streamData)));

    const messages: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await provider.chat(messages, { onToken: () => {} });

    expect(result.content).toBe('Works');
  });

  it('exposes getters for name, defaultModel, getCapabilities', () => {
    expect(provider.name).toBe('google');
    expect(provider.defaultModel).toBe('gemini-2.5-pro');
    const caps = provider.getCapabilities();
    expect(caps.maxTokens).toBe(1_000_000);
    expect(caps.streaming).toBe(true);
  });

  it('handles tool messages without preceding assistant message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(GEMINI_CHAT_RESPONSE)));

    const messages: LLMMessage[] = [
      { role: 'user', content: 'Weather?' },
      { role: 'tool', content: 'Sunny', toolCallId: 'fc_1', toolName: 'get_weather' },
    ];
    await provider.chat(messages);

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    const funcRespParts = body.contents.filter(
      (c: { parts: Array<{ functionResponse?: unknown }> }) => c.parts?.[0]?.functionResponse
    );
    expect(funcRespParts.length).toBeGreaterThanOrEqual(1);
  });
});
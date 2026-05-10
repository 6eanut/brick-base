/**
 * SSE Parser tests.
 *
 * Tests both OpenAI and Anthropic streaming formats, including:
 * - Basic event parsing
 * - [DONE] sentinel handling
 * - Chunk-boundary splits
 * - Mixed line endings
 * - Comment lines
 * - Empty/edge-case input
 */
import { describe, it, expect } from 'vitest';
import { parseSseStream, type SseEvent } from '../llm/sse-parser.js';

/**
 * Helper: create a streaming Response from a string or string[].
 * If an array is given, each element becomes a separate chunk to
 * test chunk-boundary splitting.
 */
function createStreamResponse(data: string | string[]): Response {
  if (Array.isArray(data)) {
    // Split data into chunks that arrive sequentially
    const encoder = new TextEncoder();
    const streams = data.map(chunk => encoder.encode(chunk));
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of streams) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    return new Response(stream);
  }
  return new Response(new Blob([data]).stream());
}

/**
 * Helper: consume an async generator and return all events.
 */
async function collectEvents(response: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(response)) {
    events.push(event);
  }
  return events;
}

describe('SSE Parser', () => {
  // ─── Basic parsing ────────────────────────────────────────────────────

  it('parses a single data event', async () => {
    const response = createStreamResponse('data: {"key":"value"}\n\n');
    const events = await collectEvents(response);
    expect(events).toEqual([{ event: undefined, data: '{"key":"value"}' }]);
  });

  it('parses multiple data events', async () => {
    const response = createStreamResponse(
      'data: {"first":1}\n\ndata: {"second":2}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: undefined, data: '{"first":1}' });
    expect(events[1]).toEqual({ event: undefined, data: '{"second":2}' });
  });

  // ─── OpenAI format ────────────────────────────────────────────────────

  it('parses OpenAI chat completion chunk', async () => {
    const response = createStreamResponse(
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0].data);
    expect(parsed.choices[0].delta.content).toBe('Hello');
  });

  it('handles [DONE] sentinel', async () => {
    const response = createStreamResponse(
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\ndata: [DONE]\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(2);
    expect(events[0].data).not.toBe('[DONE]');
    expect(events[1].data).toBe('[DONE]');
  });

  // ─── Anthropic format ─────────────────────────────────────────────────

  it('parses Anthropic content_block_delta event', async () => {
    const response = createStreamResponse(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('content_block_delta');
    const parsed = JSON.parse(events[0].data);
    expect(parsed.delta.text).toBe('Hello');
  });

  it('parses Anthropic message_start with event + data', async () => {
    const response = createStreamResponse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20260506"}}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message_start');
    const parsed = JSON.parse(events[0].data);
    expect(parsed.message.model).toBe('claude-sonnet-4-20260506');
  });

  it('parses multiple Anthropic events', async () => {
    const response = createStreamResponse(
      'event: ping\ndata: {"type":"ping"}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('ping');
    expect(events[1].event).toBe('content_block_start');
  });

  // ─── Line ending normalization ────────────────────────────────────────

  it('handles \\r\\n line endings', async () => {
    const response = createStreamResponse('data: {"key":"value"}\r\n\r\n');
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"key":"value"}');
  });

  it('handles \\r line endings', async () => {
    const response = createStreamResponse('data: {"key":"value"}\r\r');
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"key":"value"}');
  });

  // ─── Chunk-boundary splits ────────────────────────────────────────────

  it('handles event split across chunks', async () => {
    // The \n\n separator is split across two chunks
    const response = createStreamResponse([
      'data: {"first":1}\n',     // first chunk ends mid-separator
      '\ndata: {"second":2}\n\n', // second chunk starts with the rest
    ]);
    const events = await collectEvents(response);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('{"first":1}');
    expect(events[1].data).toBe('{"second":2}');
  });

  it('handles data split across chunks', async () => {
    // A single event's data field spans two chunks
    const response = createStreamResponse([
      'data: {"msg":"hello world","va',
      'lue":42}\n\n',
    ]);
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0].data);
    expect(parsed.msg).toBe('hello world');
    expect(parsed.value).toBe(42);
  });

  it('handles multiple chunks with multiple events each', async () => {
    const response = createStreamResponse([
      'data: {"a":1}\n\ndata: {"b',
      '":2}\n\ndata: {"c":3}\n\n',
    ]);
    const events = await collectEvents(response);
    expect(events).toHaveLength(3);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  it('ignores comment lines starting with ":"', async () => {
    const response = createStreamResponse(
      ': this is a comment\ndata: {"key":"value"}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"key":"value"}');
  });

  it('handles empty stream', async () => {
    const response = createStreamResponse('');
    const events = await collectEvents(response);
    expect(events).toHaveLength(0);
  });

  it('handles stream with only whitespace', async () => {
    const response = createStreamResponse('   \n\n  ');
    const events = await collectEvents(response);
    expect(events).toHaveLength(0);
  });

  it('handles multi-line data values', async () => {
    const response = createStreamResponse(
      'data: line1\ndata: line2\ndata: line3\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2\nline3');
  });

  it('throws on null body', async () => {
    // Create a Response with no body
    const response = new Response(null, { status: 204 });
    await expect(collectEvents(response)).rejects.toThrow('streaming not supported');
  });
});
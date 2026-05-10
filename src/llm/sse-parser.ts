/**
 * SSE (Server-Sent Events) Parser.
 *
 * A minimal, zero-dependency streaming parser that handles both
 * OpenAI and Anthropic streaming formats.
 *
 * OpenAI format:
 *   data: {"choices":[...]}
 *   data: [DONE]
 *
 * Anthropic format:
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","delta":{"text":"hello"}}
 *
 * Handles:
 * - \n, \r\n, and \r line endings
 * - Chunk-boundary splits (partial events at buffer edges)
 * - Comment lines (starting with ':')
 * - [DONE] sentinel
 */

export interface SseEvent {
  /** Optional event type (Anthropic uses this) */
  event?: string;
  /** The data payload (required) */
  data: string;
}

// Matches SSE field lines: "field: value" or "field:value"
const FIELD_RE = /^([a-zA-Z]+):\s?(.*)$/;

/**
 * Parse a single SSE block into an SseEvent.
 *
 * A block is all the text between two blank lines. It may contain:
 * - Zero or more "event:" lines (Anthropic)
 * - One or more "data:" lines (both providers)
 * - Comment lines starting with ':' (ignored)
 * - "id:" and "retry:" lines (ignored)
 */
function parseSseBlock(block: string): SseEvent {
  const lines = block.split('\n');
  let event: string | undefined;
  const dataParts: string[] = [];

  for (const line of lines) {
    // Comment lines start with ':'
    if (line.startsWith(':')) continue;

    const match = line.match(FIELD_RE);
    if (match) {
      const [, field, value] = match;
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataParts.push(value);
      }
      // id:, retry: are intentionally ignored
    }
  }

  return { event, data: dataParts.join('\n') };
}

/**
 * Async-generator that reads a streaming HTTP response and yields SSE events.
 *
 * Usage:
 *   for await (const event of parseSseStream(response)) {
 *     if (event.data === '[DONE]') break;
 *     const parsed = JSON.parse(event.data);
 *     // ...
 *   }
 */
export async function* parseSseStream(
  response: Response,
): AsyncGenerator<SseEvent> {
  if (!response.body) {
    throw new Error('Response body is null — streaming not supported');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Normalize line endings to \n
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Extract all complete events from the buffer
    while (true) {
      const idx = buffer.indexOf('\n\n');
      if (idx === -1) break;

      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // Skip empty blocks (e.g., leading blank lines)
      if (block.trim() === '') continue;

      yield parseSseBlock(block);
    }
  }

  // Process any remaining data after stream ends
  const remaining = buffer.trim();
  if (remaining) {
    yield parseSseBlock(remaining);
  }
}
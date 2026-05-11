/**
 * Core Agent Loop.
 *
 * The heart of Brick's runtime. Manages the turn-by-turn interaction:
 * 1. Receive user input
 * 2. Build prompt from conversation history + tool definitions
 * 3. Call LLM
 * 4. If LLM requests tool calls → execute tools → go back to step 2
 * 5. If LLM returns text → present to user
 */

import { type Provider, LLMMessage, LLMToolDefinition } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { ConversationManager } from './conversation.js';
import { ContextManager } from './context.js';

/** Default timeout per tool execution (2 minutes) */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Default retry config for LLM API calls */
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
};

/**
 * Race a promise against a timeout.
 * Resolves to the promise's value if it completes in time,
 * otherwise rejects with a TimeoutError.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Tool "${label}" timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Retry a function on transient failures with exponential backoff + jitter.
 * Retries on: network errors, 5xx, 429 (rate limit).
 * Does NOT retry on 4xx (auth, bad request), type errors, or invalid input.
 */
async function retry<T>(
  fn: () => Promise<T>,
  label: string,
  config?: Partial<typeof DEFAULT_RETRY_CONFIG>,
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_CONFIG, ...config };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err; // No more retries

      const isTransient = isRetryableError(err);
      if (!isTransient) throw err; // Non-transient, don't retry

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = Math.random() * delay * 0.3;
      await new Promise(r => setTimeout(r, delay + jitter));
    }
  }

  throw new Error(`Unexpected: ${label} exhausted all retries`);
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Network / TLS errors
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('TLS') || msg.includes('timed out')) return true;
  // 429 rate limit
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return true;
  // 5xx server errors
  if (/5\d{2}/.test(msg) && (msg.includes('error') || msg.includes('Internal') || msg.includes('Server'))) return true;
  return false;
}

export const AgentMode = {
  BUILD: 'build',
  PLAN: 'plan',
} as const;

export type AgentMode = (typeof AgentMode)[keyof typeof AgentMode];

export interface AgentConfig {
  systemPrompt: string;
  mode: AgentMode;
  model?: string;
  temperature?: number;
  /** Per-tool execution timeout in milliseconds (default: 120000) */
  toolTimeoutMs?: number;
}

const DEFAULT_CONFIG: AgentConfig = {
  systemPrompt: `You are Brick, a modular AI coding agent. You help users write, edit, and understand code.

Available tools let you:
- Read and write files
- Search code with regex
- List directory contents
- Execute shell commands
- Run git operations
- Use extension-provided tools

Before making changes, understand the codebase. Be precise and careful with edits.`,
  mode: AgentMode.BUILD,
  temperature: 0.7,
};

export interface AgentTurnResult {
  /** Final text response from the LLM */
  response: string;
  /** Total turns (LLM calls) used in this interaction */
  turns: number;
  /** Total tokens consumed */
  totalTokens: number;
  /** Whether tools were called */
  toolsCalled: boolean;
}

// ─── Event system for progress visualization ──────────────────────────────

export type AgentEventType =
  | 'turn_start'
  | 'llm_request'
  | 'llm_token'
  | 'llm_response'
  | 'tool_call'
  | 'tool_result'
  | 'turn_end'
  | 'final_response'
  | 'context_warning'
  | 'error'
  ;

export interface AgentEventPayloads {
  turn_start: { turn: number };
  llm_request: { turn: number };
  llm_token: { turn: number; token: string; type: 'text' | 'thinking' };
  llm_response: { turn: number; content?: string; toolCount: number };
  context_warning: { message: string };
  tool_call: { turn: number; name: string; args: Record<string, unknown> };
  tool_result: { turn: number; name: string; success: boolean; output: string; error?: string; durationMs: number };
  turn_end: { turn: number; toolCalls: number };
  final_response: { response: string; turns: number; totalTokens: number };
  error: { message: string };
}

export type AgentEventHandler<E extends AgentEventType = AgentEventType> = (data: AgentEventPayloads[E]) => void;

/** Maximum agent loop turns before giving up */
export const MAX_AGENT_TURNS = 20;

/** Maximum concurrent tool executions per LLM response */
export const MAX_CONCURRENT_TOOLS = 10;

export class AgentLoop {
  private provider: Provider;
  private toolRegistry: ToolRegistry;
  private conversation: ConversationManager;
  private contextManager: ContextManager;
  private config: AgentConfig;
  private eventHandlers: Map<AgentEventType, AgentEventHandler[]> = new Map();

  /**
   * Subscribe to agent execution events.
   */
  on<E extends AgentEventType>(event: E, handler: AgentEventHandler<E>): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.push(handler as AgentEventHandler);
    } else {
      this.eventHandlers.set(event, [handler as AgentEventHandler]);
    }
  }

  /**
   * Emit an event to all subscribers.
   */
  private emit<E extends AgentEventType>(event: E, data: AgentEventPayloads[E]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        (handler as AgentEventHandler<E>)(data);
      }
    }
  }

  constructor(
    provider: Provider,
    toolRegistry: ToolRegistry,
    options?: {
      conversation?: ConversationManager;
      contextManager?: ContextManager;
      config?: Partial<AgentConfig>;
    },
  ) {
    this.provider = provider;
    this.toolRegistry = toolRegistry;
    this.conversation = options?.conversation ?? new ConversationManager();
    this.contextManager = options?.contextManager ?? new ContextManager();
    this.config = { ...DEFAULT_CONFIG, ...options?.config };

    // Set context window from provider capabilities
    const caps = provider.getCapabilities();
    this.contextManager.setMaxTokens(caps.maxTokens);

    // Set system prompt
    this.conversation.setSystemPrompt(this.buildSystemPrompt());
  }

  /**
   * Execute a single user interaction (may involve multiple LLM→tool rounds).
   */
  async run(input: string): Promise<AgentTurnResult> {
    this.conversation.addUserMessage(input);

    let turns = 0;

    // Persist user input
    this.conversation.persist().catch(() => {});
    let totalTokens = 0;
    let toolsCalled = false;
    let finalResponse = '';

    // Multi-turn loop: LLM may request multiple tool calls
    while (turns < MAX_AGENT_TURNS) {
      turns++;

      // Emit turn start
      this.emit('turn_start', { turn: turns });

      const messages = this.prepareMessages();
      const toolDefs = this.prepareToolDefs();

      // Emit LLM request
      this.emit('llm_request', { turn: turns });

      let response: import('../llm/provider.js').LLMResponse;
      try {
        response = await retry(
          () =>
            this.provider.chat(messages, {
              model: this.config.model,
              tools: toolDefs,
              temperature: this.config.temperature,
              onToken: (token: string) => {
                this.emit('llm_token', { turn: turns, token, type: 'text' });
              },
              onThinkingToken: (token: string) => {
                this.emit('llm_token', { turn: turns, token, type: 'thinking' });
              },
            }),
          'LLM chat',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit('error', { message });
        throw err; // Re-throw so caller can handle
      }

      totalTokens += response.usage.totalTokens;

      // Emit LLM response
      this.emit('llm_response', {
        turn: turns,
        content: response.content ?? undefined,
        toolCount: response.toolCalls.length,
      });

      // Check for tool calls
      if (response.toolCalls.length > 0) {
        toolsCalled = true;

        // ── Step 1: Parse all arguments (serial, lightweight) ─────────
        type PendingTool = {
          tc: typeof response.toolCalls[0];
          args: Record<string, unknown>;
          error?: string;
        };
        const pendingTools: PendingTool[] = [];

        for (const tc of response.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            // Invalid JSON — skip execution, report error to LLM
            pendingTools.push({
              tc,
              args: {},
              error: `Error: Invalid JSON arguments: ${tc.function.arguments}`,
            });
            continue;
          }

          // Plan mode enforcement: block non-read-only tools
          if (this.config.mode === AgentMode.PLAN) {
            const toolDef = this.toolRegistry.get(tc.function.name);
            if (!toolDef || !toolDef.readOnly) {
              pendingTools.push({
                tc,
                args: {},
                error: `Error: "${tc.function.name}" is not available in plan mode. Only read-only tools are allowed.`,
              });
              continue;
            }
          }

          pendingTools.push({ tc, args });
        }

        // ── Step 2: Emit tool_call events for ALL tools ──────────────
        for (const pt of pendingTools) {
          this.emit('tool_call', { turn: turns, name: pt.tc.function.name, args: pt.args });
        }

        // ── Step 3: Execute all valid tools in parallel ──────────────
        // Results are stored by original index to preserve order.
        const results: Array<{
          result: import('../tools/registry.js').ToolResult;
          durationMs: number;
        } | { error: string }> = new Array(pendingTools.length);

        // Execute in batches to cap concurrency
        for (let i = 0; i < pendingTools.length; i += MAX_CONCURRENT_TOOLS) {
          const batch = pendingTools.slice(i, i + MAX_CONCURRENT_TOOLS);
          const batchResults = await Promise.all(
            batch.map(async (pt, batchIdx) => {
              const originalIdx = i + batchIdx;
              // Skip tools with parse errors
              if (pt.error) {
                return { idx: originalIdx, result: null, durationMs: 0, error: pt.error };
              }
              const startTime = Date.now();
              try {
                const result = await withTimeout(
                  this.toolRegistry.execute(pt.tc.function.name, pt.args),
                  this.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
                  pt.tc.function.name,
                );
                const durationMs = Date.now() - startTime;
                return { idx: originalIdx, result, durationMs, error: undefined };
              } catch (err) {
                const durationMs = Date.now() - startTime;
                return {
                  idx: originalIdx,
                  result: null,
                  durationMs,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            }),
          );

          for (const br of batchResults) {
            if (br.error) {
              results[br.idx] = { error: br.error };
            } else {
              results[br.idx] = { result: br.result!, durationMs: br.durationMs };
            }
          }
        }

        // ── Step 4: Emit results + add tool messages (ordered) ───────
        for (let i = 0; i < pendingTools.length; i++) {
          const pt = pendingTools[i];
          const res = results[i];

          if ('error' in res) {
            this.emit('tool_result', {
              turn: turns,
              name: pt.tc.function.name,
              success: false,
              output: '',
              error: res.error,
              durationMs: 0,
            });
            this.conversation.addToolMessage(pt.tc.id, pt.tc.function.name, res.error);
          } else {
            this.emit('tool_result', {
              turn: turns,
              name: pt.tc.function.name,
              success: res.result.success,
              output: res.result.output,
              error: res.result.error,
              durationMs: res.durationMs,
            });
            this.conversation.addToolMessage(
              pt.tc.id,
              pt.tc.function.name,
              this.formatToolResult(res.result),
            );
          }
        }

        // Add assistant's tool call message to conversation
        if (response.content) {
          this.conversation.addAssistantMessage(response.content);
        }

        // Persist all conversation changes from this turn
        this.conversation.persist().catch(() => {});

        // Emit turn end
        this.emit('turn_end', { turn: turns, toolCalls: response.toolCalls.length });

        // Continue loop for next LLM response with tool results
        continue;
      }

      // No tool calls — final response
      finalResponse = response.content ?? '';
      this.conversation.addAssistantMessage(finalResponse);

      // Persist final response
      this.conversation.persist().catch(() => {});

      // Emit final response
      this.emit('final_response', { response: finalResponse, turns, totalTokens });
      break;
    }

    // Turn limit reached without producing final response
    if (turns >= MAX_AGENT_TURNS && finalResponse === '') {
      finalResponse = `⚠️  Agent reached the maximum of ${MAX_AGENT_TURNS} turns without producing a final response. Try simplifying your request or breaking it into smaller steps.`;
      this.emit('final_response', { response: finalResponse, turns, totalTokens });
    }

    return {
      response: finalResponse,
      turns,
      totalTokens,
      toolsCalled,
    };
  }

  /**
   * Switch agent mode.
   */
  setMode(mode: AgentMode): void {
    this.config.mode = mode;
    this.conversation.setSystemPrompt(this.buildSystemPrompt());
  }

  getMode(): AgentMode {
    return this.config.mode;
  }

  getConversation(): ConversationManager {
    return this.conversation;
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  private buildSystemPrompt(): string {
    const parts: string[] = [this.config.systemPrompt];

    if (this.config.mode === AgentMode.PLAN) {
      parts.push(
        '\n## Mode: PLAN\nYou are in plan mode. You can read and analyze code but cannot make any edits, write files, or execute commands. Provide analysis, suggestions, and plans only.',
      );
    }

    return parts.join('\n');
  }

  private prepareMessages(): LLMMessage[] {
    const messages = this.conversation.getMessages();

    // Check if we're near the limit
    const estimatedTokens = this.contextManager.estimateMessageTokens(messages);
    const caps = this.provider.getCapabilities();
    const threshold = caps.maxTokens * 0.8;
    if (estimatedTokens > threshold) {
      this.emit('context_warning', {
        message: `Context at ~${Math.round(estimatedTokens / 1000)}K/${(caps.maxTokens / 1000).toFixed(0)}K tokens`,
      });
    }

    // Truncate if needed
    const truncated = this.contextManager.truncateMessages(messages);

    return truncated.map(m => ({
      role: m.role as LLMMessage['role'],
      content: m.content,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      images: m.images,
    }));
  }

  private prepareToolDefs(): LLMToolDefinition[] | undefined {
    if (this.config.mode === AgentMode.PLAN) {
      return this.toolRegistry.getReadOnlyDefinitions();
    }
    return this.toolRegistry.getLLMDefinitions();
  }

  private formatToolResult(result: { success: boolean; output: string; error?: string }): string {
    if (!result.success && result.error) {
      return `Error: ${result.error}`;
    }
    return result.output;
  }
}
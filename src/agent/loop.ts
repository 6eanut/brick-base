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

import { LLMProvider, LLMMessage, LLMToolDefinition } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { ConversationManager } from './conversation.js';
import { ContextManager } from './context.js';

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
  | 'llm_response'
  | 'tool_call'
  | 'tool_result'
  | 'turn_end'
  | 'final_response'
  | 'error'
  ;

export interface AgentEventPayloads {
  turn_start: { turn: number };
  llm_request: { turn: number };
  llm_response: { turn: number; content?: string; toolCount: number };
  tool_call: { turn: number; name: string; args: Record<string, unknown> };
  tool_result: { turn: number; name: string; success: boolean; output: string; error?: string; durationMs: number };
  turn_end: { turn: number; toolCalls: number };
  final_response: { response: string; turns: number; totalTokens: number };
  error: { message: string };
}

export type AgentEventHandler<E extends AgentEventType = AgentEventType> = (data: AgentEventPayloads[E]) => void;

/** Maximum agent loop turns before giving up */
export const MAX_AGENT_TURNS = 20;

export class AgentLoop {
  private provider: LLMProvider;
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
    provider: LLMProvider,
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

    // Set system prompt
    this.conversation.setSystemPrompt(this.buildSystemPrompt());
  }

  /**
   * Execute a single user interaction (may involve multiple LLM→tool rounds).
   */
  async run(input: string): Promise<AgentTurnResult> {
    this.conversation.addUserMessage(input);

    let turns = 0;
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
        response = await this.provider.chat(messages, {
          model: this.config.model,
          tools: toolDefs,
          temperature: this.config.temperature,
        });
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

        // Execute each tool call
        for (const tc of response.toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            // Invalid JSON arguments — send error back to LLM
            this.conversation.addToolMessage(
              tc.id,
              tc.function.name,
              `Error: Invalid JSON arguments: ${tc.function.arguments}`,
            );
            continue;
          }

          // Emit tool call before execution
          this.emit('tool_call', {
            turn: turns,
            name: tc.function.name,
            args,
          });

          const startTime = Date.now();
          const result = await this.toolRegistry.execute(tc.function.name, args);
          const durationMs = Date.now() - startTime;

          // Emit tool result after execution
          this.emit('tool_result', {
            turn: turns,
            name: tc.function.name,
            success: result.success,
            output: result.output,
            error: result.error,
            durationMs,
          });

          this.conversation.addToolMessage(tc.id, tc.function.name, this.formatToolResult(result));
        }

        // Add assistant's tool call message to conversation
        if (response.content) {
          this.conversation.addAssistantMessage(response.content);
        }

        // Emit turn end
        this.emit('turn_end', { turn: turns, toolCalls: response.toolCalls.length });

        // Continue loop for next LLM response with tool results
        continue;
      }

      // No tool calls — final response
      finalResponse = response.content ?? '';
      this.conversation.addAssistantMessage(finalResponse);

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

    // Truncate if needed
    const truncated = this.contextManager.truncateMessages(messages);

    return truncated.map(m => ({
      role: m.role as LLMMessage['role'],
      content: m.content,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
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
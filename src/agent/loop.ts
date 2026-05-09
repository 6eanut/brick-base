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

export class AgentLoop {
  private provider: LLMProvider;
  private toolRegistry: ToolRegistry;
  private conversation: ConversationManager;
  private contextManager: ContextManager;
  private config: AgentConfig;

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
    while (turns < 20) {
      // Limit to 20 tool rounds
      const messages = this.prepareMessages();
      const toolDefs = this.prepareToolDefs();

      const response = await this.provider.chat(messages, {
        model: this.config.model,
        tools: toolDefs,
        temperature: this.config.temperature,
      });

      turns++;
      totalTokens += response.usage.totalTokens;

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

          const result = await this.toolRegistry.execute(tc.function.name, args);
          this.conversation.addToolMessage(tc.id, tc.function.name, this.formatToolResult(result));
        }

        // Add assistant's tool call message to conversation
        if (response.content) {
          this.conversation.addAssistantMessage(response.content);
        }

        // Continue loop for next LLM response with tool results
        continue;
      }

      // No tool calls — final response
      finalResponse = response.content;
      this.conversation.addAssistantMessage(finalResponse);
      break;
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
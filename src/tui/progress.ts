/**
 * Progress Renderer — rewritten for multi-line, professional output.
 *
 * Features:
 *   - Multi-line text streaming (full content, not just last 80 chars)
 *   - Tool call grouping with in-place result updates
 *   - Context progress bar when approaching token limits
 *   - Simple code block highlighting in streamed output
 *   - Compact turn summary with timing and token counts
 *
 * Lifecycle:
 *   llm_request  → start spinner "LLM is thinking..."
 *   llm_token    → stream tokens into a growing output zone
 *   tool_call    → add to tool group tree, render in-place
 *   tool_result  → update tool group tree in-place
 *   turn_end     → print compact turn summary
 *   final_response → cleanup, finalize state
 */

import chalk from 'chalk';
import type { AgentEventPayloads } from '../agent/loop.js';
import { MAX_AGENT_TURNS } from '../agent/loop.js';
import { theme } from './theme.js';
import { formatDuration, formatTokens } from './utils.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;
const MAX_OUTPUT_PREVIEW = 200;

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'success' | 'error';
  durationMs?: number;
  output?: string;
  error?: string;
}

export class ProgressRenderer {
  private isTty: boolean;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private spinnerTurn = 0;

  // Streaming state
  private isStreaming = false;
  private streamingTurn = 0;
  private streamedContent = '';
  private streamedLineCount = 0;

  // Tool group state
  private toolCalls: ToolCallInfo[] = [];
  private toolGroupLineCount = 0;
  private toolGroupResultsReceived = 0;

  // Turn timing
  private turnStartTime = 0;

  constructor() {
    this.isTty = !!process.stdout.isTTY;
  }

  // ─── Spinner ──────────────────────────────────────────────────────────────

  /**
   * Start the thinking spinner.
   * Called on 'llm_request' event.
   */
  showThinking(data: AgentEventPayloads['llm_request']): void {
    this.clearStreaming();
    this.clearToolGroup();
    this.clearSpinner();

    if (!this.isTty) {
      this.turnStartTime = Date.now();
      return;
    }

    this.spinnerTurn = data.turn;
    this.spinnerFrame = 0;
    this.turnStartTime = Date.now();

    const label = `LLM is thinking...  Turn ${this.spinnerTurn}`;
    process.stdout.write(`  ${SPINNER_FRAMES[0]} ${label}`);
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r  ${SPINNER_FRAMES[this.spinnerFrame]} ${label}`);
    }, SPINNER_INTERVAL_MS);
  }

  /**
   * Stop the spinner and erase its line.
   */
  private clearSpinner(): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.isTty) {
      process.stdout.write('\r\x1b[K');
    }
  }

  // ─── Streaming ────────────────────────────────────────────────────────────

  /**
   * Show a streaming token.
   * Called on 'llm_token' event.
   *
   * Thinking tokens are accumulated silently.
   * Text tokens are streamed to a permanent output zone.
   */
  showToken(data: AgentEventPayloads['llm_token']): void {
    // Thinking tokens — accumulate silently (no visual output)
    if (data.type === 'thinking') return;

    if (!this.isTty) {
      // Non-TTY: accumulate silently — final response will be printed by pagerThrough
      return;
    }

    if (!this.isStreaming) {
      this.clearSpinner();
      this.clearToolGroup();
      this.isStreaming = true;
      this.streamingTurn = data.turn;
      this.streamedContent = '';
      this.streamedLineCount = 0;
    }

    this.streamedContent += data.token;

    // Re-render the full streamed content in-place
    this.renderStreamedContent();
  }

  /**
   * Render all accumulated streamed content.
   *
   * Uses cursor-up + clear-lines to overwrite the previous streaming zone,
   * then writes the full accumulated content. This keeps the streaming
   * zone as a permanent record.
   */
  private renderStreamedContent(): void {
    if (this.streamedLineCount > 0) {
      // Cursor up to the start of the streaming zone
      process.stdout.write(`\x1b[${this.streamedLineCount}A`);
    }

    // Build the rendered lines
    const rendered = this.highlightCodeBlocks(this.streamedContent);
    const lines = rendered.split('\n');

    // Header line
    const header = `  ${theme.primary('📝')} ${chalk.bold('Output:')}`;

    // Content lines — wrap to terminal width minus indentation
    const contentLines = this.wrapLines(lines);

    // Combine header + content
    const totalLines = [header, ...contentLines.map(l => `  ${l}`)];

    // Calculate new line count
    this.streamedLineCount = totalLines.length;

    // Clear previous content and write new
    for (let i = 0; i < this.streamedLineCount; i++) {
      process.stdout.write('\r\x1b[K');
      if (i > 0) process.stdout.write('\n');
    }
    // Cursor back to top
    process.stdout.write(`\x1b[${this.streamedLineCount}A`);

    // Write the content
    for (const line of totalLines) {
      process.stdout.write(line + '\n');
    }
  }

  /**
   * Highlight simple code blocks in streamed content.
   * Applies cyan to content between triple backticks, green to quoted strings.
   */
  private highlightCodeBlocks(text: string): string {
    // Simple pass: detect ```...``` blocks and apply cyan
    let result = '';
    let inCodeBlock = false;
    let i = 0;

    while (i < text.length) {
      if (text.startsWith('```', i)) {
        result += theme.dim('```');
        i += 3;
        inCodeBlock = !inCodeBlock;
        continue;
      }

      if (inCodeBlock) {
        // In code block — apply highlighting
        // Find end of current line
        const nextNewline = text.indexOf('\n', i);
        const line = nextNewline >= 0 ? text.slice(i, nextNewline) : text.slice(i);

        result += theme.code(line);
        if (nextNewline >= 0) {
          result += '\n';
          i = nextNewline + 1;
        } else {
          i = text.length;
        }
      } else {
        result += text[i];
        i++;
      }
    }

    return result;
  }

  /**
   * Wrap long lines to terminal width.
   */
  private wrapLines(lines: string[]): string[] {
    const wrapped: string[] = [];
    const width = process.stdout.columns ?? 80;
    const indentWidth = 2;

    for (const line of lines) {
      if (line.length <= width - indentWidth) {
        wrapped.push(line);
      } else {
        // Simple greedy wrap at the character level for streaming
        let remaining = line;
        while (remaining.length > 0) {
          wrapped.push(remaining.slice(0, width - indentWidth));
          remaining = remaining.slice(width - indentWidth);
        }
      }
    }

    return wrapped;
  }

  /**
   * Clear the streaming zone.
   */
  private clearStreaming(): void {
    if (this.isStreaming) {
      this.isStreaming = false;
      this.streamedContent = '';
      this.streamedLineCount = 0;
    }
  }

  // ─── LLM Response ─────────────────────────────────────────────────────────

  /**
   * Show LLM response summary.
   * Called on 'llm_response' event.
   */
  showLLMResponse(data: AgentEventPayloads['llm_response']): void {
    this.clearSpinner();

    if (!this.isTty) {
      // Non-TTY: content will be printed by pagerThrough — no duplicate output
      return;
    }

    const toolCount = data.toolCount ?? 0;

    if (toolCount > 0) {
      // LLM is requesting tools — show reasoning brief if available
      const reasoning = data.content ?? '';
      if (reasoning && reasoning.length > 3) {
        const preview = reasoning.length > 120
          ? reasoning.slice(0, 120) + '…'
          : reasoning;
        console.log(`  ${theme.warning('💭')} ${theme.muted(preview)}`);
      }

      // Only print header if there's no streaming content already
      if (!this.isStreaming) {
        console.log(`  ${theme.primary('🔧')} ${chalk.bold(`Requesting ${toolCount} tool call(s)...`)}`);
      }
    }

    // Stop streaming mode — the content zone is now permanent
    this.isStreaming = false;
  }

  // ─── Tool Group ───────────────────────────────────────────────────────────

  /**
   * Show a tool invocation and add it to the tool group.
   * Called on 'tool_call' event.
   *
   * Accumulates all tool calls of this turn into a grouped tree block
   * that gets rendered/updated in-place.
   */
  showToolCall(data: AgentEventPayloads['tool_call']): void {
    this.clearSpinner();

    if (!this.isTty) {
      // Non-TTY: silent — output is for the pager/final response only
      return;
    }

    // Ensure streaming zone is finalized
    if (this.isStreaming) {
      // Print a newline to separate streaming from tools
      console.log();
      this.isStreaming = false;
    }

    this.toolCalls.push({
      name: data.name,
      args: data.args,
      status: 'pending',
    });

    this.renderToolGroup();
  }

  /**
   * Show tool execution result and update the tool group.
   * Called on 'tool_result' event.
   */
  showToolResult(data: AgentEventPayloads['tool_result']): void {
    this.clearSpinner();

    if (!this.isTty) {
      // Non-TTY: silent — output is for the pager/final response only
      return;
    }

    // Find the matching tool call by name (sequential matching for duplicates)
    const idx = this.toolCalls.findIndex(
      t => t.name === data.name && t.status === 'pending',
    );

    if (idx >= 0) {
      this.toolCalls[idx] = {
        ...this.toolCalls[idx],
        status: data.success ? 'success' : 'error',
        durationMs: data.durationMs,
        output: data.output,
        error: data.error,
      };
      this.toolGroupResultsReceived++;
    }

    this.renderToolGroup();

    // Cursor is already past the tool group block after renderToolGroup()
    // No extra movement needed — next output lands after it naturally.
  }

  /**
   * Render the tool group tree in-place.
   *
   * Uses cursor-up to overwrite the previous tool group block,
   * then renders the current state of all tool calls.
   */
  private renderToolGroup(): void {
    if (this.toolCalls.length === 0) return;

    // Calculate new height: 1 header + N tool lines
    const newHeight = 1 + this.toolCalls.length;

    // If we already rendered, cursor-up to overwrite
    if (this.toolGroupLineCount > 0) {
      process.stdout.write(`\x1b[${this.toolGroupLineCount}A`);
    }

    // Determine header based on state
    const allDone = this.toolCalls.every(t => t.status !== 'pending');
    const headerLabel = allDone && this.toolCalls.length > 0
      ? `  ${theme.primary('🔧')} ${chalk.bold(`Executed ${this.toolCalls.length} tool call(s):`)}`
      : `  ${theme.primary('🔧')} ${chalk.bold(`${this.toolCalls.length} tool call(s):`)}`;

    // Clear old lines and write header
    process.stdout.write('\r\x1b[K' + headerLabel + '\n');

    // Write each tool line
    for (let i = 0; i < this.toolCalls.length; i++) {
      const tc = this.toolCalls[i];
      const isLast = i === this.toolCalls.length - 1;
      const prefix = isLast ? '  └──' : '  ├──';

      process.stdout.write('\r\x1b[K' + this.formatToolLine(prefix, tc) + '\n');
    }

    // Update tracked line count
    this.toolGroupLineCount = newHeight;
  }

  /**
   * Format a single tool line for the group tree.
   */
  private formatToolLine(prefix: string, tc: ToolCallInfo): string {
    const name = chalk.bold(tc.name);

    switch (tc.status) {
      case 'pending':
      case 'running': {
        const argsPreview = this.summarizeArgs(tc.args);
        const argsStr = argsPreview ? theme.muted(` ${argsPreview}`) : '';
        return `${prefix} ${name}${argsStr}`;
      }
      case 'success': {
        const duration = tc.durationMs !== undefined
          ? theme.muted(` (${formatDuration(tc.durationMs)})`)
          : '';
        const preview = tc.output ? theme.muted(` — ${this.truncateOutput(tc.output)}`) : '';
        return `${prefix} ${theme.success('✅')} ${name} ${theme.success('OK')}${duration}${preview}`;
      }
      case 'error': {
        const duration = tc.durationMs !== undefined
          ? theme.muted(` (${formatDuration(tc.durationMs)})`)
          : '';
        const errMsg = tc.error ? theme.muted(` — ${tc.error}`) : '';
        return `${prefix} ${theme.error('❌')} ${name} ${theme.error('FAIL')}${duration}${errMsg}`;
      }
    }
  }

  /**
   * Clear the tool group tracking.
   */
  private clearToolGroup(): void {
    this.toolCalls = [];
    this.toolGroupLineCount = 0;
    this.toolGroupResultsReceived = 0;
  }

  // ─── Turn End ─────────────────────────────────────────────────────────────

  /**
   * Show end-of-turn summary.
   * Called on 'turn_end' event.
   */
  showTurnEnd(_data: AgentEventPayloads['turn_end']): void {
    if (!this.isTty) {
      // Non-TTY: silent
      return;
    }

    const turn = _data.turn;
    const calls = _data.toolCalls;
    const elapsed = Date.now() - this.turnStartTime;

    console.log(`  ${theme.muted(`⏳ Turn ${turn}/${MAX_AGENT_TURNS} · ${calls} tool call(s) · ${formatDuration(elapsed)}`)}`);

    // Reset tool group tracking for next turn
    this.clearToolGroup();
  }

  // ─── Finalize ─────────────────────────────────────────────────────────────

  /**
   * Clean up all visual state.
   * Called via 'final_response' event.
   */
  finish(): void {
    this.clearStreaming();
    this.clearSpinner();
    // Tool groups are left visible as execution trace
    this.toolCalls = [];
    this.toolGroupLineCount = 0;
    this.toolGroupResultsReceived = 0;
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  /**
   * Handle errors during agent execution.
   */
  showError(data: AgentEventPayloads['error']): void {
    this.clearSpinner();
    const msg = `  ${theme.error('❌ Error')} ${theme.error(data.message)}`;
    if (this.isTty) {
      console.log(msg);
    } else {
      console.error(msg);
    }
  }

  /**
   * Show context window warning with a visual progress bar.
   */
  showContextWarning(data: AgentEventPayloads['context_warning']): void {
    // Parse the warning message to extract token counts
    // Format: "Context at ~XXK/XXXK tokens"
    const match = data.message.match(/~(\d+)K\/(\d+)K/);
    if (match) {
      const current = parseInt(match[1], 10);
      const max = parseInt(match[2], 10);
      const pct = Math.round((current / max) * 100);
      const bar = this.renderProgressBar(pct, 10);
      console.log(`  ${theme.warning('⚠')} Context: ${bar} ${pct}% (${current}K/${max}K tokens)`);
    } else {
      console.log(`  ${theme.warning('⚠')} ${theme.warning(data.message)}`);
    }
  }

  /**
   * Render a simple ASCII progress bar.
   *
   * @param pct - Percentage filled (0-100)
   * @param segments - Number of bar segments (default 10)
   */
  private renderProgressBar(pct: number, segments: number = 10): string {
    const filled = Math.round((pct / 100) * segments);
    const empty = segments - filled;

    const filledChar = theme.warning('█');
    const emptyChar = theme.dim('░');

    return filledChar.repeat(filled) + emptyChar.repeat(empty);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Summarize tool arguments for inline display.
   * Skips large values like file content, keeps only identifying params.
   */
  private summarizeArgs(args: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 100) continue;
      if (typeof value === 'object' && value !== null) {
        parts.push(`${key}: ${JSON.stringify(value)}`);
      } else if (typeof value === 'string') {
        parts.push(`${key}: "${value}"`);
      } else {
        parts.push(`${key}: ${String(value)}`);
      }
    }
    return parts.join(', ');
  }

  /**
   * Truncate tool output for preview display.
   */
  private truncateOutput(output: string): string {
    if (!output) return '';
    const cleaned = output.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= MAX_OUTPUT_PREVIEW) return cleaned;
    return cleaned.slice(0, MAX_OUTPUT_PREVIEW) + '…';
  }
}
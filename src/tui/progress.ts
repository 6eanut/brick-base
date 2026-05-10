/**
 * Progress Renderer.
 *
 * Renders agent execution progress in real-time to the terminal.
 * Uses chalk-based inline updates and a spinner animation — no React/Ink dependency.
 *
 * Lifecycle:
 *   llm_request  → start spinner "LLM is thinking..."
 *   llm_response → stop spinner, optionally show reasoning summary
 *   tool_call    → print tool invocation line
 *   tool_result  → print tool result line (success/failure, duration, preview)
 *   turn_end     → print turn summary
 *   final_response → cleanup spinner, restore clean cursor state
 */

import chalk from 'chalk';

import type { AgentEventPayloads } from '../agent/loop.js';
import { MAX_AGENT_TURNS } from '../agent/loop.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 100;
const MAX_OUTPUT_PREVIEW = 200;

export class ProgressRenderer {
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private spinnerTurn = 0;
  private streamingTurn = 0;
  private isStreaming = false;
  private streamedContent = '';

  /**
   * Start the thinking spinner.
   * Called on 'llm_request' event.
   */
  showThinking(data: AgentEventPayloads['llm_request']): void {
    this.clearStreaming();
    this.clearSpinner();
    this.spinnerTurn = data.turn;
    this.spinnerFrame = 0;
    this.streamingTurn = 0;
    this.isStreaming = false;
    this.streamedContent = '';
    const label = `LLM is thinking...  Turn ${this.spinnerTurn}`;
    process.stdout.write(`  ${SPINNER_FRAMES[0]} ${label}`);
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r  ${SPINNER_FRAMES[this.spinnerFrame]} ${label}`);
    }, SPINNER_INTERVAL_MS);
  }

  /**
   * Stop the spinner (called before printing a permanent line).
   */
  private clearSpinner(): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    // Erase the spinner line
    process.stdout.write('\r\x1b[K');
  }

  /**
   * Clear the streaming line (if active).
   */
  private clearStreaming(): void {
    if (this.isStreaming) {
      this.isStreaming = false;
      this.streamedContent = '';
      process.stdout.write('\r\x1b[K');
    }
  }

  /**
   * Show LLM response summary.
   * Called on 'llm_response' event. Stops the spinner and optionally
   * displays the LLM's intermediate reasoning.
   */
  showLLMResponse(data: AgentEventPayloads['llm_response']): void {
    this.clearStreaming();
    this.clearSpinner();
    const toolCount = data.toolCount ?? 0;

    if (toolCount > 0) {
      // LLM is requesting tools — show reasoning brief if available
      const reasoning = data.content ?? '';
      if (reasoning && reasoning.length > 3) {
        const preview = reasoning.length > 120
          ? reasoning.slice(0, 120) + '…'
          : reasoning;
        console.log(`  ${chalk.yellow('💭')} ${chalk.gray(preview)}`);
      }
      console.log(`  ${chalk.cyan('🔧')} ${chalk.bold(`Requesting ${toolCount} tool call(s)...`)}`);
    }
  }

  /**
   * Show a streaming token.
   * Called on 'llm_token' event.
   *
   * On first token: clears spinner, shows streaming header.
   * On subsequent tokens: updates single-line preview (last ~80 chars).
   * Thinking tokens are accumulated silently (not rendered to avoid flicker).
   */
  showToken(data: AgentEventPayloads['llm_token']): void {
    // Thinking tokens are accumulated but not rendered
    if (data.type === 'thinking') return;

    if (!this.isStreaming) {
      this.clearSpinner();
      this.isStreaming = true;
      this.streamingTurn = data.turn;
      this.streamedContent = '';
      process.stdout.write(`  ${chalk.cyan('📝')} ${chalk.bold('LLM output:')} `);
    }

    this.streamedContent += data.token;

    // Show last ~80 chars as a preview, replacing newlines with spaces
    const preview = this.streamedContent
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      // Strip ANSI escape codes to prevent terminal corruption
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .slice(-80)
      .trim();

    // Write the preview, then clear to end of line
    process.stdout.write(`\r  ${chalk.cyan('📝')} ${chalk.bold('LLM output:')} ${chalk.gray(preview)}\x1b[K`);
  }

  /**
   * Show a tool invocation.
   * Called on 'tool_call' event.
   */
  showToolCall(data: AgentEventPayloads['tool_call']): void {
    this.clearSpinner();
    const argsPreview = this.summarizeArgs(data.args);
    const argsStr = argsPreview ? chalk.gray(`(${argsPreview})`) : '';
    console.log(`  ${chalk.cyan('🔧')} ${chalk.bold(data.name)}${argsStr}`);
  }

  /**
   * Show tool execution result.
   * Called on 'tool_result' event.
   */
  showToolResult(data: AgentEventPayloads['tool_result']): void {
    this.clearSpinner();
    const status = data.success ? chalk.green('OK') : chalk.red('FAIL');
    const duration = data.durationMs > 1000
      ? chalk.gray(`(${(data.durationMs / 1000).toFixed(1)}s)`)
      : chalk.gray(`(${data.durationMs}ms)`);

    const preview = data.success
      ? this.truncateOutput(data.output)
      : (data.error ?? 'unknown error');

    const icon = data.success ? chalk.green('✅') : chalk.red('❌');
    console.log(
      `  ${icon} ${chalk.bold(data.name)} ${status} ${duration}${preview ? chalk.gray(` — ${preview}`) : ''}`,
    );
  }

  /**
   * Show end-of-turn summary.
   * Called on 'turn_end' event.
   */
  showTurnEnd(data: AgentEventPayloads['turn_end']): void {
    const turn = data.turn;
    const calls = data.toolCalls;
    console.log(`  ${chalk.gray(`⏳ Turn ${turn}/${MAX_AGENT_TURNS} — ${calls} tool call(s)`)}`);
  }

  /**
   * Clean up spinner state.
   * Called via 'final_response' event subscription. Erases the spinner line
   * from the terminal so the final response prints cleanly.
   *
   * Progress lines (tool calls, results, turn summaries) are intentionally
   * left visible — they serve as an execution trace for the user.
   */
  finish(): void {
    this.clearStreaming();
    this.clearSpinner();
  }

  /**
   * Handle errors during agent execution.
   */
  showError(data: AgentEventPayloads['error']): void {
    this.clearSpinner();
    console.log(`  ${chalk.red('❌ Error')} ${chalk.red(data.message)}`);
  }

  /**
   * Show context window warning.
   */
  showContextWarning(data: AgentEventPayloads['context_warning']): void {
    console.log(`  ${chalk.yellow('⚠')} ${chalk.yellow(data.message)}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Summarize tool arguments for inline display.
   * Skips large values like file content, keeps only identifying params.
   */
  private summarizeArgs(args: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      // Skip large string values (file content, large data)
      if (typeof value === 'string' && value.length > 100) continue;
      // Skip binary/object blobs
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
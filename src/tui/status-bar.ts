/**
 * Status bar — subtle bottom status line.
 *
 * Writes a single line at the bottom of the terminal showing
 * mode, model, provider, tool count, and token usage.
 * Uses ansi-escapes for precise cursor positioning.
 * Auto-disabled when output is piped (non-TTY).
 */

import ansiEscapes from 'ansi-escapes';
import { theme } from './theme.js';
import { terminalWidth, isTty } from './utils.js';

export interface StatusBarState {
  mode: string;
  model: string;
  provider: string;
  toolCount: number;
  totalTokens?: number;
}

let lastContent = '';
let isActive = false;

/**
 * Write or update the status bar at the bottom of the terminal.
 *
 * Call with the current state at startup, after mode changes,
 * after turns, and after final responses.
 *
 * Pass `null` to clear the status bar entirely.
 */
export function updateStatusBar(state: StatusBarState | null): void {
  if (!isTty()) return;

  if (state === null) {
    // Clear the status bar (2 lines: separator + content)
    if (isActive && lastContent) {
      process.stdout.write(ansiEscapes.cursorUp(2));
      process.stdout.write(ansiEscapes.eraseLines(2));
      isActive = false;
      lastContent = '';
    }
    return;
  }

  const width = terminalWidth();

  // Build content segments
  const modeTag = state.mode === 'plan'
    ? theme.warning(` ${state.mode} `)
    : theme.success(` ${state.mode} `);

  const modelTag = theme.highlight(state.model);
  const providerTag = theme.muted(state.provider);
  const toolsTag = theme.muted(`tools: ${state.toolCount}`);
  const tokensTag = state.totalTokens !== undefined
    ? theme.muted(`tokens: ${state.totalTokens.toLocaleString()}`)
    : null;

  const segments = [
    modeTag,
    theme.dim('│'),
    ` ${modelTag} `,
    theme.dim('│'),
    ` ${providerTag} `,
    theme.dim('│'),
    ` ${toolsTag} `,
  ];

  if (tokensTag) {
    segments.push(theme.dim('│'), ` ${tokensTag} `);
  }

  const rawContent = segments.join('');

  // Build the separator line
  const separator = theme.dim('─'.repeat(Math.min(width, 80)));

  // Truncate content if too wide (minus 1 for safety)
  const maxContentWidth = width - 2;
  const displayContent = rawContent.length > maxContentWidth
    ? rawContent.slice(0, maxContentWidth - 1) + '…'
    : rawContent;

  const fullContent = `${separator}\n${displayContent}`;

  if (fullContent === lastContent) return; // No change needed

  // If a status bar already exists, overwrite it in-place (cursor up 2 lines)
  if (isActive) {
    process.stdout.write(ansiEscapes.cursorUp(2));
    process.stdout.write(ansiEscapes.eraseLines(2));
  }

  // Write the new status bar
  process.stdout.write(fullContent + '\n');
  isActive = true;
  lastContent = fullContent;
}

/**
 * Check whether the status bar is currently active.
 */
export function isStatusBarActive(): boolean {
  return isActive;
}
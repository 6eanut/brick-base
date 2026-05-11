/**
 * Forward-only pager for long output.
 *
 * Displays long text page-by-page (or line-by-line) in the terminal.
 * Invoked for LLM responses longer than the terminal height.
 * Auto-skips when stdout is piped or not a TTY.
 *
 * Controls:
 *   Space   — next page
 *   Enter   — next line
 *   q       — quit / skip remaining
 *   Any key — next page (same as Space)
 */

import { terminalHeight, terminalWidth, isTty, wordWrap } from './utils.js';
import { readKey } from './raw-keypress.js';

/** Lines reserved for the prompt line and status bar */
const RESERVED_LINES = 2;

/**
 * Display `text` through a forward-only pager.
 *
 * Pages are sized to fit the current terminal height minus reserved lines.
 * Returns immediately if not a TTY or text is short enough to fit on screen.
 */
export async function pagerThrough(text: string): Promise<void> {
  if (!isTty()) {
    // Non-interactive: just print it
    console.log(text);
    return;
  }

  const lines = wordWrap(text, terminalWidth() - 2);
  const pageLines = Math.max(5, terminalHeight() - RESERVED_LINES - 2); // -2 for pager prompt

  if (lines.length <= pageLines) {
    // Fits on one screen — no paging needed
    console.log(text);
    return;
  }

  let currentLine = 0;

  while (currentLine < lines.length) {
    const endLine = Math.min(currentLine + pageLines, lines.length);
    const chunk = lines.slice(currentLine, endLine).join('\n');
    const remaining = lines.length - endLine;

    console.log(chunk);

    if (remaining <= 0) break;

    // Show the prompt and wait for keypress
    const prompt = remaining > 0
      ? `  ${'─'.repeat(4)} ${remaining} more line(s) — ${themeKeyHint()}`
      : '';

    if (prompt) {
      process.stdout.write(`\n${prompt}\n`);
    }

    const key = await readKey();

    // Clear the prompt line(s) — cursor up 2 lines
    if (prompt) {
      process.stdout.write('\x1b[2A'); // cursor up 2
      process.stdout.write('\x1b[K\n\x1b[K'); // clear both lines
      process.stdout.write('\x1b[1A'); // back up
    }

    if (key === 'q' || key === 'escape' || key === 'ctrl-c' || key === 'ctrl-d') {
      // Quit — show "(skipped N lines)" and done
      console.log(`  ${gray(`(skipped ${remaining} line(s))`)}`);
      return;
    }

    if (key === 'return') {
      // Enter — advance by 1 line
      currentLine += 1;
    } else {
      // Space or any other key — advance by one page
      currentLine = endLine;
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function themeKeyHint(): string {
  const space = bold('Space');
  const enter = bold('Enter');
  const quit = bold('q');
  return `[${space}] next page  [${enter}] next line  [${quit}] quit`;
}

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[22m`;
}

function gray(s: string): string {
  return `\x1b[2m${s}\x1b[22m`;
}
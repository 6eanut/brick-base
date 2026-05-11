/**
 * Terminal UI utility functions.
 *
 * Pure helpers for terminal-aware formatting — no chalk/boxen dependency.
 */

import stripAnsi from 'strip-ansi';

/**
 * Get the current terminal width in columns.
 * Falls back to 80 if not a TTY.
 */
export function terminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * Get the current terminal height in rows.
 * Falls back to 24 if not a TTY.
 */
export function terminalHeight(): number {
  return process.stdout.rows ?? 24;
}

/**
 * Check if stdout is connected to a terminal (not piped).
 */
export function isTty(): boolean {
  return process.stdout.isTTY ?? false;
}

/**
 * Truncate a string (possibly containing ANSI codes) to a max visible length.
 * Preserves ANSI codes at the end so coloring isn't broken.
 *
 * @param str - The string to truncate
 * @param maxLen - Maximum visible character length
 * @returns Truncated string with '…' appended if truncated
 */
export function truncateAnsi(str: string, maxLen: number): string {
  const visible = stripAnsi(str);
  if (visible.length <= maxLen) return str;

  // Find the truncation point in the original string
  let visibleCount = 0;
  let result = '';
  // Simple state machine to skip ANSI escape sequences
  let inEscape = false;
  for (const char of str) {
    if (char === '\x1b') {
      inEscape = true;
      result += char;
      continue;
    }
    if (inEscape) {
      result += char;
      if (char === 'm') {
        inEscape = false;
      }
      continue;
    }
    if (visibleCount < maxLen) {
      result += char;
      visibleCount++;
    } else {
      // We've reached the max — stop adding visible chars
      // but keep consuming to add trailing ANSI reset if needed
      break;
    }
  }

  return result + '…';
}

/**
 * Word-wrap text to a given width, preserving existing newlines.
 *
 * @param text - The text to wrap
 * @param width - Maximum line width (default: terminal width)
 * @returns Array of wrapped lines
 */
export function wordWrap(text: string, width: number = terminalWidth()): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    const stripped = stripAnsi(paragraph);
    if (stripped.length <= width) {
      lines.push(paragraph);
      continue;
    }

    // Break the paragraph at word boundaries
    const words = paragraph.split(/(?<=\s)/);
    let currentLine = '';
    let currentLen = 0;

    for (const word of words) {
      const wordLen = stripAnsi(word).length;
      if (currentLen + wordLen > width && currentLen > 0) {
        lines.push(currentLine);
        currentLine = word;
        currentLen = wordLen;
      } else {
        currentLine += word;
        currentLen += wordLen;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Count the number of visible lines a block of text would occupy
 * when wrapped to the given width.
 *
 * @param text - The text
 * @param width - Wrap width
 * @returns Number of visible lines
 */
export function countVisibleLines(text: string, width: number = terminalWidth()): number {
  return wordWrap(text, width).length;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns e.g. "1.2s" or "350ms"
 */
export function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/**
 * Format a token count with thousands separator.
 *
 * @param tokens - Number of tokens
 * @returns e.g. "1,542"
 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}
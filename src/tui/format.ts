/**
 * Boxen-based formatters for command output.
 *
 * Wraps common output types (help, tools, extensions, stats, errors, etc.)
 * in boxen boxes with semantic border colors from the theme.
 */

import boxen from 'boxen';
import { theme } from './theme.js';

// ─── Shared boxen options ──────────────────────────────────────────────────

const INFO_BOX = { borderColor: '#58a6ff', borderStyle: 'round', padding: 1, margin: { top: 0, bottom: 1 }, float: 'left' } as const;
const SUCCESS_BOX = { borderColor: 'green', borderStyle: 'round', padding: 1, margin: { top: 0, bottom: 1 }, float: 'left' } as const;
const WARN_BOX = { borderColor: 'yellow', borderStyle: 'round', padding: 1, margin: { top: 0, bottom: 1 }, float: 'left' } as const;
const ERROR_BOX = { borderColor: 'red', borderStyle: 'round', padding: 1, margin: { top: 0, bottom: 1 }, float: 'left' } as const;
const MUTED_BOX = { borderColor: 'gray', borderStyle: 'round', padding: 1, margin: { top: 0, bottom: 1 }, float: 'left' } as const;

// ─── Public formatters ─────────────────────────────────────────────────────

/**
 * Generic info box with an optional title.
 */
export function formatInfo(title: string | undefined, content: string): string {
  return boxen(content, {
    ...INFO_BOX,
    title: title ? theme.muted(title) : undefined,
    titleAlignment: 'left',
  });
}

/**
 * Formatted /help output.
 * `commands` — array of { name, description } objects.
 */
export function formatHelp(commands: Array<{ name: string; description: string }>): string {
  const lines = commands.map(c => {
    const padded = c.name.padEnd(35);
    return `  ${theme.highlight(padded)}${theme.muted(c.description)}`;
  });
  return boxen(lines.join('\n'), {
    ...INFO_BOX,
    title: theme.muted('Available Commands'),
    titleAlignment: 'left',
  });
}

/**
 * Formatted /tools output.
 * `tools` — array of { name, description, source? } objects.
 * When `source` is provided (e.g. "extension:lsp"), a dim source tag is shown.
 */
export function formatTools(tools: Array<{ name: string; description: string; source?: string }>): string {
  const lines = tools.map(t => {
    const padded = t.name.padEnd(35);
    const srcTag = t.source ? theme.dim(` [${t.source}]`) : '';
    return `  ${theme.highlight(padded)}${theme.muted(t.description)}${srcTag}`;
  });
  return boxen(lines.join('\n'), {
    ...INFO_BOX,
    title: theme.muted(`Registered Tools (${tools.length})`),
    titleAlignment: 'left',
  });
}

/**
 * Formatted /extensions output.
 * `extensions` — array of { name, version, description?, enabled?, configurable? }.
 */
export function formatExtensions(
  extensions: Array<{ name: string; version: string; description?: string; enabled?: boolean; configurable?: boolean }>,
): string {
  if (extensions.length === 0) {
    return boxen(`  ${theme.muted('No extensions installed.')}`, MUTED_BOX);
  }

  const lines = extensions.map(e => {
    const statusTag = e.enabled === false ? theme.warning(' (disabled)') : theme.success(' ✓');
    const configTag = e.configurable ? theme.dim(' (configurable)') : '';
    const desc = e.description ? `\n    ${theme.muted(e.description)}` : '';
    return `  ${theme.code(e.name)} v${e.version}${statusTag}${configTag}${desc}`;
  });
  return boxen(lines.join('\n'), {
    ...INFO_BOX,
    title: theme.muted(`Extensions (${extensions.length})`),
    titleAlignment: 'left',
  });
}

/**
 * Formatted /stats output.
 * `table` — pre-formatted table string.
 */
export function formatStats(table: string): string {
  return boxen(table, {
    ...INFO_BOX,
    title: theme.muted('Tool Usage Stats'),
    titleAlignment: 'left',
  });
}

/**
 * Red-bordered error message box.
 */
export function formatError(message: string): string {
  return boxen(` ${theme.error('✖')} ${message}`, ERROR_BOX);
}

/**
 * Green-bordered success message box.
 */
export function formatSuccess(message: string): string {
  return boxen(` ${theme.success('✔')} ${message}`, SUCCESS_BOX);
}

/**
 * Yellow-bordered warning message box.
 */
export function formatWarning(message: string): string {
  return boxen(` ${theme.warning('⚠')} ${message}`, WARN_BOX);
}

/**
 * Gray-bordered informational message box.
 */
export function formatMessage(message: string): string {
  return boxen(`  ${theme.muted(message)}`, MUTED_BOX);
}

/**
 * Format an agent's final response in a blue-bordered box.
 * Handles multiline content gracefully.
 */
export function formatResponse(response: string): string {
  const trimmed = response.trim();
  if (!trimmed) return '';

  // Detect if response looks like code — wrap in code styling
  const hasCodeBlock = trimmed.includes('```');
  const content = hasCodeBlock ? trimmed : trimmed;

  return boxen(`  ${content}`, {
    ...INFO_BOX,
    title: theme.muted('Response'),
    titleAlignment: 'left',
  });
}
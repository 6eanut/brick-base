/**
 * Brick startup banner.
 *
 * ASCII art "BRICK" logo + configuration summary in a boxen box.
 * Invoked once at session start.
 */

import boxen from 'boxen';
import { theme, boxenPresets } from './theme.js';

/** The ASCII art BRICK logo lines. */
const LOGO = [
  '██████╗ ██████╗ ██╗ ██████╗██╗  ',
  '██╔══██╗██╔══██╗██║██╔════╝██║  ',
  '██████╔╝██████╔╝██║██║     ██║  ',
  '██╔══██╗██╔══██╗██║██║     ██║  ',
  '██████╔╝██║  ██║██║╚██████╗██║  ',
  '╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ',
];

export interface BannerConfig {
  version: string;
  provider: string;
  model: string;
  tools: number;
  mode: string;
  extensions?: number;
}

/**
 * Print the startup banner to stdout.
 *
 * Displays the ASCII art logo, version, and configuration summary
 * inside a rounded box. The banner is suppressed when stdout is
 * not a TTY (piped output).
 */
export function printBanner(config: BannerConfig): void {
  // Skip banner when piped
  if (!process.stdout.isTTY) return;

  const versionLine = `v${config.version} · Modular AI Coding Agent`;
  const separator = '─'.repeat(versionLine.length + 2);

  const logoText = LOGO.map(line => `  ${theme.primary(line)}`).join('\n');

  const configLines = [
    theme.muted(separator),
    `  ${theme.muted('Provider:')} ${theme.highlight(config.provider)}`,
    `  ${theme.muted('Model:')}   ${theme.highlight(config.model)}`,
    `  ${theme.muted('Tools:')}   ${theme.bold(String(config.tools))}  ${theme.muted('|')}  ${theme.muted('Mode:')} ${theme.bold(config.mode)}`,
    config.extensions !== undefined
      ? `  ${theme.muted('Extensions:')} ${theme.bold(String(config.extensions))}`
      : '',
    '',
    `  ${theme.dim('💡 Type /help for commands  ·  /exit to quit')}`,
  ].filter(Boolean).join('\n');

  const bannerContent = [
    logoText,
    '',
    `  ${theme.bold(versionLine)}`,
    configLines,
  ].join('\n');

  console.log(
    boxen(bannerContent, {
      borderColor: '#58a6ff',
      borderStyle: 'round',
      padding: 1,
      margin: { top: 1, bottom: 0 },
      float: 'left',
    }),
  );
}

/**
 * Print a warning banner when no API key is configured.
 * Uses a yellow-bordered box instead of the full logo.
 */
export function printWarningBanner(message: string): void {
  if (!process.stdout.isTTY) return;

  console.log(
    boxen(` ${theme.warning('⚠')} ${message}`, {
      borderColor: 'yellow',
      borderStyle: 'round',
      padding: 1,
      margin: { top: 1, bottom: 0 },
      float: 'left',
    }),
  );
}
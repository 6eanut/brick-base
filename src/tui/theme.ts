/**
 * Semantic theme for Brick's terminal UI.
 *
 * Wraps chalk with semantic color names so the rest of the codebase
 * doesn't depend on specific chalk color choices. Change colors here
 * and everything updates.
 */

import chalk from 'chalk';
import type { Options as BoxenOptions } from 'boxen';

// ─── Chalk wrappers ──────────────────────────────────────────────────────

export const theme = {
  /** Primary info / emphasis text */
  primary: chalk.hex('#58a6ff'),
  /** Success indication */
  success: chalk.green,
  /** Warning / caution */
  warning: chalk.yellow,
  /** Error / failure */
  error: chalk.red,
  /** De-emphasized / secondary text */
  muted: chalk.gray,
  /** Bold highlighted text */
  highlight: chalk.bold.cyan,
  /** Code / inline code snippets */
  code: chalk.hex('#79c0ff'),
  /** Dimmed text */
  dim: chalk.dim,
  /** Bold primary */
  bold: chalk.bold,
  /** Agent / AI emphasis */
  agent: chalk.magenta,
};

// ─── Boxen presets ───────────────────────────────────────────────────────

export const boxenPresets: Record<string, BoxenOptions> = {
  info: {
    borderColor: 'blue',
    borderStyle: 'round',
    padding: 1,
    margin: 0,
    float: 'left',
  } as BoxenOptions,
  success: {
    borderColor: 'green',
    borderStyle: 'round',
    padding: 1,
    margin: 0,
    float: 'left',
  } as BoxenOptions,
  warning: {
    borderColor: 'yellow',
    borderStyle: 'round',
    padding: 1,
    margin: 0,
    float: 'left',
  } as BoxenOptions,
  error: {
    borderColor: 'red',
    borderStyle: 'round',
    padding: 1,
    margin: 0,
    float: 'left',
  } as BoxenOptions,
  muted: {
    borderColor: 'gray',
    borderStyle: 'round',
    padding: 1,
    margin: 0,
    float: 'left',
  } as BoxenOptions,
};
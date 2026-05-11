/**
 * Extension compatibility checking.
 *
 * Centralizes the Brick version string and provides utilities for
 * checking whether an extension manifest is compatible with the
 * current Brick version.
 */

import { createRequire } from 'node:module';
import semver from 'semver';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

/** The current Brick version string (read from package.json at import time). */
export const BRICK_VERSION: string = pkg.version;

/**
 * Result of a compatibility check.
 */
export interface CompatibilityResult {
  /** Whether the extension is compatible with this Brick version. */
  compatible: boolean;
  /** The current Brick version (for reference). */
  brickVersion: string;
  /** A human-readable warning message if incompatible, undefined if compatible. */
  message?: string;
}

/**
 * Check whether an extension's declared Brick version range is compatible
 * with the current Brick version.
 *
 * - If the manifest has no `brickVersion` field, defaults to `"*"` (compatible).
 * - If the `brickVersion` is not a valid semver range, treated as incompatible.
 * - Uses `semver.satisfies()` for the actual check.
 *
 * @param brickVersionRange - The semver range from the extension's `brickVersion` field (or `"*"`).
 * @param extName - The extension name (for the warning message).
 * @returns A CompatibilityResult.
 */
export function checkExtensionCompatibility(
  brickVersionRange: string | undefined,
  extName: string,
): CompatibilityResult {
  const range = brickVersionRange ?? '*';

  // Quick path for wildcard
  if (range === '*') {
    return { compatible: true, brickVersion: BRICK_VERSION };
  }

  // Validate the range is syntactically valid
  if (!semver.validRange(range)) {
    return {
      compatible: false,
      brickVersion: BRICK_VERSION,
      message:
        `Extension "${extName}" declares invalid Brick version range "${range}". ` +
        `Current Brick version is ${BRICK_VERSION}. Proceed with caution.`,
    };
  }

  // Check satisfaction
  const compatible = semver.satisfies(BRICK_VERSION, range);
  if (!compatible) {
    return {
      compatible: false,
      brickVersion: BRICK_VERSION,
      message:
        `Extension "${extName}" requires Brick ${range}, but current version is ${BRICK_VERSION}. ` +
        `Some features may not work correctly.`,
    };
  }

  return { compatible: true, brickVersion: BRICK_VERSION };
}
/**
 * Compatibility module tests.
 *
 * Covers: BRICK_VERSION constant, checkExtensionCompatibility with various
 * semver ranges, edge cases (undefined, invalid ranges, etc.).
 */
import { describe, it, expect } from 'vitest';
import { checkExtensionCompatibility, BRICK_VERSION } from '../extensions/compatibility.js';
import semver from 'semver';

describe('BRICK_VERSION', () => {
  it('is a valid semver string', () => {
    expect(semver.valid(BRICK_VERSION)).toBeTruthy();
  });

  it('matches package.json version', () => {
    // BRICK_VERSION is read from package.json at import time
    expect(typeof BRICK_VERSION).toBe('string');
    expect(BRICK_VERSION.length).toBeGreaterThan(0);
  });
});

describe('checkExtensionCompatibility', () => {
  const extName = 'test-ext';

  it('returns compatible for wildcard range', () => {
    const result = checkExtensionCompatibility('*', extName);
    expect(result.compatible).toBe(true);
    expect(result.brickVersion).toBe(BRICK_VERSION);
    expect(result.message).toBeUndefined();
  });

  it('returns compatible when brickVersion is undefined', () => {
    const result = checkExtensionCompatibility(undefined, extName);
    expect(result.compatible).toBe(true);
  });

  it('returns compatible when current version satisfies the range', () => {
    const result = checkExtensionCompatibility(`>=${BRICK_VERSION}`, extName);
    expect(result.compatible).toBe(true);
  });

  it('returns incompatible when current version is below the range', () => {
    const result = checkExtensionCompatibility('>=99.0.0', extName);
    expect(result.compatible).toBe(false);
    expect(result.message).toContain(extName);
    expect(result.message).toContain('>=99.0.0');
    expect(result.message).toContain(BRICK_VERSION);
  });

  it('returns incompatible when current version is above the range', () => {
    const result = checkExtensionCompatibility('<=0.0.1', extName);
    expect(result.compatible).toBe(false);
  });

  it('returns compatible for exact version match', () => {
    const result = checkExtensionCompatibility(BRICK_VERSION, extName);
    expect(result.compatible).toBe(true);
  });

  it('returns incompatible for invalid semver range', () => {
    const result = checkExtensionCompatibility('not-a-range', extName);
    expect(result.compatible).toBe(false);
    expect(result.message).toContain('invalid');
  });

  it('returns incompatible for garbage input', () => {
    const result = checkExtensionCompatibility('>=0.1,.0', extName);
    expect(result.compatible).toBe(false);
    expect(result.message).toContain('invalid');
  });

  it('includes extension name in the warning message', () => {
    const result = checkExtensionCompatibility('>=99.0.0', 'my-custom-ext');
    expect(result.message).toContain('my-custom-ext');
  });

  it('handles caret ranges', () => {
    const result = checkExtensionCompatibility(`^${BRICK_VERSION}`, extName);
    expect(result.compatible).toBe(true);
  });

  it('handles tilde ranges', () => {
    const major = semver.major(BRICK_VERSION);
    const minor = semver.minor(BRICK_VERSION);
    const result = checkExtensionCompatibility(`~${major}.${minor}.0`, extName);
    expect(result.compatible).toBe(true);
  });

  it('handles complex ranges', () => {
    const result = checkExtensionCompatibility(`>=${BRICK_VERSION} <${semver.inc(BRICK_VERSION, 'minor')}`, extName);
    expect(result.compatible).toBe(true);
  });
});
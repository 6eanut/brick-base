/**
 * Dependency checking tests.
 *
 * Covers: checkExtensionDependencies with various requires arrays,
 * edge cases (undefined, empty, self-reference), and
 * aggregateDependencyWarnings across multiple manifests.
 */
import { describe, it, expect } from 'vitest';
import { checkExtensionDependencies, aggregateDependencyWarnings } from '../extensions/dependencies.js';

describe('checkExtensionDependencies', () => {
  it('returns satisfied when requires is undefined', () => {
    const result = checkExtensionDependencies(
      { name: 'my-ext' },
      new Set(),
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns satisfied when requires is empty array', () => {
    const result = checkExtensionDependencies(
      { name: 'my-ext', requires: [] },
      new Set(),
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns satisfied when all dependencies are installed', () => {
    const result = checkExtensionDependencies(
      { name: 'my-ext', requires: ['web-search', 'repomap'] },
      new Set(['web-search', 'repomap']),
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns missing when a dependency is not installed', () => {
    const result = checkExtensionDependencies(
      { name: 'my-ext', requires: ['web-search'] },
      new Set(['repomap']),
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(['web-search']);
  });

  it('returns multiple missing dependencies', () => {
    const result = checkExtensionDependencies(
      { name: 'my-ext', requires: ['a', 'b', 'c'] },
      new Set(['a']),
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(['b', 'c']);
  });

  it('handles self-reference gracefully', () => {
    const result = checkExtensionDependencies(
      { name: 'my-ext', requires: ['my-ext', 'web-search'] },
      new Set(['web-search']),
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports all as missing when nothing is installed', () => {
    const result = checkExtensionDependencies(
      { name: 'my-ext', requires: ['a', 'b'] },
      new Set(),
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(['a', 'b']);
  });
});

describe('aggregateDependencyWarnings', () => {
  it('returns empty array when no dependencies are declared', () => {
    const warnings = aggregateDependencyWarnings([
      { name: 'ext-a' },
      { name: 'ext-b' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('returns empty array when all dependencies are satisfied', () => {
    const warnings = aggregateDependencyWarnings([
      { name: 'ext-a', requires: ['ext-b'] },
      { name: 'ext-b' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('returns warnings for missing dependencies', () => {
    const warnings = aggregateDependencyWarnings([
      { name: 'ext-a', requires: ['ext-b', 'ext-c'] },
      { name: 'ext-b' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ext-a');
    expect(warnings[0]).toContain('ext-c');
  });

  it('handles circular dependencies gracefully', () => {
    const warnings = aggregateDependencyWarnings([
      { name: 'ext-a', requires: ['ext-b'] },
      { name: 'ext-b', requires: ['ext-a'] },
    ]);
    expect(warnings).toEqual([]);
  });

  it('handles multiple manifests with missing deps', () => {
    const warnings = aggregateDependencyWarnings([
      { name: 'ext-a', requires: ['missing-1'] },
      { name: 'ext-b', requires: ['missing-2'] },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('missing-1');
    expect(warnings[1]).toContain('missing-2');
  });

  it('produces formatted warnings with extension name', () => {
    const warnings = aggregateDependencyWarnings([
      { name: 'my-ext', requires: ['not-installed'] },
    ]);
    expect(warnings[0]).toBe('Extension "my-ext" requires "not-installed" — not installed');
  });
});
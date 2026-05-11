/**
 * Extension dependency checking.
 *
 * Utilities for checking whether an extension's declared dependencies
 * (the `requires` field in brick.json) are satisfied by installed
 * extensions. All checks are non-blocking — they return results
 * rather than throwing.
 */

export interface DependencyCheckResult {
  /** Extension names that are required but not installed */
  missing: string[];
  /** True if all dependencies are satisfied */
  satisfied: boolean;
}

/**
 * Check whether a single extension's dependencies are satisfied.
 *
 * @param manifest - The extension manifest (or object with `name` and optional `requires`)
 * @param installedNames - Set of installed extension names
 * @returns DependencyCheckResult with missing deps and overall status
 */
export function checkExtensionDependencies(
  manifest: { name: string; requires?: string[] },
  installedNames: Set<string>,
): DependencyCheckResult {
  const requires = manifest.requires;

  // No dependencies declared — trivially satisfied
  if (!requires || requires.length === 0) {
    return { missing: [], satisfied: true };
  }

  // Filter to dependencies not in the installed set
  // Self-references are satisfied automatically
  const missing = requires.filter(dep => dep !== manifest.name && !installedNames.has(dep));

  return {
    missing,
    satisfied: missing.length === 0,
  };
}

/**
 * Aggregate dependency warnings across multiple manifests.
 *
 * Collects all extension names into a set, then checks each manifest's
 * dependencies against that set. Returns formatted warning strings for
 * any missing dependencies.
 *
 * @param manifests - Array of extension manifests
 * @returns Formatted warning strings (one per missing dependency)
 */
export function aggregateDependencyWarnings(
  manifests: Array<{ name: string; requires?: string[] }>,
): string[] {
  // Collect all installed extension names
  const installedNames = new Set(manifests.map(m => m.name));

  const warnings: string[] = [];

  for (const manifest of manifests) {
    const result = checkExtensionDependencies(manifest, installedNames);
    for (const dep of result.missing) {
      warnings.push(`Extension "${manifest.name}" requires "${dep}" — not installed`);
    }
  }

  return warnings;
}
/**
 * Extension registry.
 *
 * Manages the lifecycle of Brick extensions:
 * - Discovery: scanning extension directories for brick.json manifests
 * - Registration: loading extension metadata and capabilities
 * - Lifecycle: install, uninstall, enable, disable
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

import { checkExtensionCompatibility } from './compatibility.js';
import { aggregateDependencyWarnings } from './dependencies.js';

/** Path to the persisted extension state file. */
const STATE_FILE = join(homedir(), '.brick', 'extensions-state.json');

export interface ConfigSchemaEntry {
  /** Value type */
  type: 'string' | 'number' | 'boolean' | 'select';
  /** Human-readable description of what this setting does */
  description: string;
  /** Default value if user hasn't set one */
  default?: unknown;
  /** Allowed options for 'select' type */
  options?: string[];
  /** Human-readable label (shown in CLI display) */
  label?: string;
  /** Whether this setting must be provided (default false) */
  required?: boolean;
}

export interface ExtensionManifest {
  /** Unique extension name (e.g. "repomap") */
  name: string;
  /** Optional npm package name for update resolution (e.g. "@brick/extension-web-search") */
  package?: string;
  /** Semver version */
  version: string;
  /** @default "*" — semver range that this extension requires (e.g. ">=0.1.0") */
  brickVersion?: string;
  /** Names of other Brick extensions this extension depends on */
  requires?: string[];
  /** Human-readable description */
  description: string;
  /** Extension type — always "mcp" for v1 */
  type: 'mcp';
  /** MCP server configuration */
  mcp: {
    /** Command to start the MCP server */
    command: string;
    /** Arguments for the command */
    args: string[];
    /** Environment variables to pass */
    env?: Record<string, string>;
  };
  /** Capabilities this extension provides */
  capabilities: {
    /** Tool names this extension exposes */
    tools: string[];
    /** Slash commands this extension registers */
    commands: string[];
    /** Event hooks this extension supports */
    hooks: string[];
  };
  /** Declared configuration schema — what settings this extension accepts */
  config?: Record<string, ConfigSchemaEntry>;
}

export interface ExtensionState {
  manifest: ExtensionManifest;
  /** Absolute path to the extension directory */
  path: string;
  /** Whether the extension is currently loaded */
  enabled: boolean;
  /** Timestamp when the extension was installed */
  installedAt: string;
}

export class ExtensionRegistry {
  private extensions: Map<string, ExtensionState> = new Map();
  private searchPaths: string[];
  /** Persisted enabled/disabled state, loaded from STATE_FILE */
  private enabledState: Map<string, boolean> = new Map();

  constructor(searchPaths: string[] = []) {
    this.searchPaths = [
      ...searchPaths,
      join(homedir(), '.brick', 'extensions'),
      join(process.cwd(), 'extensions'),
    ];
    this.loadState().catch(() => {});
  }

  /**
   * Persist the enabled/disabled state to disk.
   */
  private async saveState(): Promise<void> {
    const state: Record<string, boolean> = {};
    for (const [name, enabled] of this.enabledState) {
      state[name] = enabled;
    }
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Load the enabled/disabled state from disk.
   * Missing entries default to enabled: true.
   */
  private async loadState(): Promise<void> {
    if (!existsSync(STATE_FILE)) return;
    try {
      const content = await readFile(STATE_FILE, 'utf-8');
      const state = JSON.parse(content) as Record<string, boolean>;
      for (const [name, enabled] of Object.entries(state)) {
        this.enabledState.set(name, enabled);
      }
    } catch {
      // Ignore invalid state files
    }
  }

  /**
   * Get the persisted enabled state for an extension.
   * Defaults to true if not explicitly set.
   */
  private getPersistedEnabled(name: string): boolean {
    return this.enabledState.has(name) ? this.enabledState.get(name)! : true;
  }

  /**
   * Register an extension from its manifest (used during install or manual add).
   */
  register(manifest: ExtensionManifest, extPath: string): void {
    this.extensions.set(manifest.name, {
      manifest,
      path: extPath,
      enabled: this.getPersistedEnabled(manifest.name),
      installedAt: new Date().toISOString(),
    });
  }

  /**
   * Unregister an extension (remove from registry, keep files on disk).
   */
  unregister(name: string): boolean {
    return this.extensions.delete(name);
  }

  get(name: string): ExtensionState | undefined {
    return this.extensions.get(name);
  }

  listAll(): ExtensionState[] {
    return Array.from(this.extensions.values());
  }

  listEnabled(): ExtensionState[] {
    return this.listAll().filter(ext => ext.enabled);
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const ext = this.extensions.get(name);
    if (!ext) return false;
    ext.enabled = enabled;
    this.enabledState.set(name, enabled);
    this.saveState().catch(() => {});
    return true;
  }

  /**
   * Scan search paths for installed extensions and load their manifests.
   * Each extension directory must contain a `brick.json` manifest.
   */
  async discover(): Promise<ExtensionManifest[]> {
    const discovered: ExtensionManifest[] = [];

    for (const searchPath of this.searchPaths) {
      const resolvedPath = resolve(searchPath.replace(/^~/, homedir()));

      if (!existsSync(resolvedPath)) continue;

      try {
        const entries = await readdir(resolvedPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.')) continue;

          const manifestPath = join(resolvedPath, entry.name, 'brick.json');
          if (!existsSync(manifestPath)) continue;

          try {
            const content = await readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(content) as ExtensionManifest;
            manifest.capabilities.tools ??= [];
            manifest.capabilities.commands ??= [];
            manifest.capabilities.hooks ??= [];

            // Check Brick version compatibility (non-blocking warning)
            if (manifest.brickVersion !== undefined) {
              const compatResult = checkExtensionCompatibility(manifest.brickVersion, manifest.name);
              if (!compatResult.compatible && compatResult.message) {
                console.warn(`\n  ⚠  ${compatResult.message}`);
              }
            }

            this.register(manifest, join(resolvedPath, entry.name));
            discovered.push(manifest);
          } catch {
            // Skip invalid manifests silently
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }

    // Check cross-extension dependencies (non-blocking warning)
    const depWarnings = aggregateDependencyWarnings(discovered);
    for (const warning of depWarnings) {
      console.warn(`\n  ⚠  ${warning}`);
    }

    return discovered;
  }

  /**
   * Get all tool names from all enabled extensions.
   */
  getAllExtensionToolNames(): string[] {
    const names: string[] = [];
    for (const ext of this.listEnabled()) {
      names.push(...ext.manifest.capabilities.tools);
    }
    return names;
  }
}
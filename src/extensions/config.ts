/**
 * Extension configuration manager.
 *
 * Manages per-extension user configuration:
 * - Persistence: user overrides stored in ~/.brick/extensions-config.json
 * - Merge: user values combined with brick.json defaults
 * - Coercion: CLI string input → typed values (number, boolean)
 * - Env generation: config values → BRICK_CFG_* env vars for MCP servers
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExtensionRegistry, ConfigSchemaEntry } from './registry.js';

/** Path to the persisted extension config file. */
const CONFIG_FILE = join(homedir(), '.brick', 'extensions-config.json');

export class ExtensionConfigManager {
  private configs: Map<string, Record<string, unknown>> = new Map();
  private getRegistry: () => ExtensionRegistry;

  constructor(getRegistry: () => ExtensionRegistry) {
    this.getRegistry = getRegistry;
    this.loadConfigs().catch(() => {});
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Persist user config overrides to disk.
   */
  private async saveConfigs(): Promise<void> {
    const state: Record<string, Record<string, unknown>> = {};
    for (const [name, cfg] of this.configs) {
      state[name] = cfg;
    }
    await writeFile(CONFIG_FILE, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Load user config overrides from disk.
   */
  private async loadConfigs(): Promise<void> {
    if (!existsSync(CONFIG_FILE)) return;
    try {
      const content = await readFile(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>;
      for (const [name, cfg] of Object.entries(parsed)) {
        this.configs.set(name, cfg);
      }
    } catch {
      // Ignore invalid config files
    }
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  /**
   * Get the config schema for an extension from its manifest.
   */
  getSchema(extName: string): Record<string, ConfigSchemaEntry> | undefined {
    const registry = this.getRegistry();
    const ext = registry.get(extName);
    return ext?.manifest.config;
  }

  /**
   * Check if an extension has configurable settings.
   */
  hasConfig(extName: string): boolean {
    return this.getSchema(extName) !== undefined;
  }

  // ── Config access ────────────────────────────────────────────────────────

  /**
   * Get the effective config for an extension.
   * Merges user overrides on top of brick.json defaults.
   */
  getConfig(extName: string): Record<string, unknown> {
    const schema = this.getSchema(extName);
    if (!schema) return {};

    const userOverrides = this.configs.get(extName) ?? {};
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(schema)) {
      result[key] = userOverrides[key] ?? entry.default ?? null;
    }

    return result;
  }

  /**
   * Set a single config key for an extension.
   * Coerces the string value to the correct type based on schema.
   * Returns a status message string.
   */
  setConfig(extName: string, key: string, value: string): string {
    const schema = this.getSchema(extName);
    if (!schema) {
      return `Extension "${extName}" has no configurable settings.`;
    }

    const entry = schema[key];
    if (!entry) {
      return `Unknown config key "${key}". Available keys: ${Object.keys(schema).join(', ')}`;
    }

    const coerced = this.coerceValue(value, entry.type);

    // For 'select' type, validate against options
    if (entry.type === 'select' && entry.options && !entry.options.includes(String(coerced))) {
      return `Invalid value for "${key}". Allowed: ${entry.options.join(', ')}`;
    }

    const cfg = this.configs.get(extName) ?? {};
    cfg[key] = coerced;
    this.configs.set(extName, cfg);
    this.saveConfigs().catch(() => {});

    return `  ${key} = ${JSON.stringify(coerced)}`;
  }

  // ── Env var generation ───────────────────────────────────────────────────

  /**
   * Get config values as BRICK_CFG_* environment variables.
   */
  getConfigAsEnv(extName: string): Record<string, string> {
    const config = this.getConfig(extName);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== null && value !== undefined) {
        env[`BRICK_CFG_${key.toUpperCase()}`] = String(value);
      }
    }
    return env;
  }

  // ── Display ──────────────────────────────────────────────────────────────

  /**
   * Format all config for an extension as a human-readable string.
   * Returns plain text (no chalk styling — callers can add their own).
   */
  formatConfig(extName: string): string {
    const schema = this.getSchema(extName);
    if (!schema) {
      return `Extension "${extName}" has no configurable settings.`;
    }

    const effective = this.getConfig(extName);
    const userOverrides = this.configs.get(extName) ?? {};
    const lines: string[] = [`Configuration for "${extName}":`];

    for (const [key, entry] of Object.entries(schema)) {
      const label = entry.label ?? key;
      const value = effective[key];
      const isOverridden = key in userOverrides;
      const formattedValue = value === null ? '(not set)' : JSON.stringify(value);

      let typeHint: string;
      if (entry.type === 'select') {
        typeHint = ` [${entry.options?.join('|')}]`;
      } else {
        typeHint = ` (${entry.type})`;
      }

      const marker = isOverridden ? '*' : ' ';
      lines.push(`  ${marker} ${label}${typeHint} = ${formattedValue}`);
      if (entry.description) {
        lines.push(`    ${entry.description}`);
      }
      if (entry.default !== undefined) {
        lines.push(`    default: ${JSON.stringify(entry.default)}`);
      }
    }

    return lines.join('\n');
  }

  // ── Coercion ─────────────────────────────────────────────────────────────

  /**
   * Coerce a string value to the target type.
   */
  private coerceValue(value: string, type: string): unknown {
    switch (type) {
      case 'number': {
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
      }
      case 'boolean':
        return value === 'true' || value === '1' || value === 'yes';
      case 'select':
      case 'string':
      default:
        return value;
    }
  }
}
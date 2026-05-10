/**
 * Configuration manager for Brick.
 *
 * Supports multiple config layers (CLI args > env vars > config file > defaults)
 * using the `conf` package for persistent user settings.
 */

export interface ProviderConfigEntry {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export interface BrickConfig {
  /** Default LLM provider to use */
  defaultProvider: string;

  /** Per-provider settings */
  providers: Record<string, ProviderConfigEntry>;

  /** Extensions to auto-load on startup */
  extensions: string[];

  /** Directories to search for installed extensions */
  extensionPaths: string[];

  /** Shell execution settings */
  shell: {
    /** Directories allowed for command execution (empty = cwd only) */
    allowedDirectories: string[];
    /** Default timeout in ms */
    timeout: number;
    /** Maximum output size in bytes */
    maxOutputBytes: number;
    /** Regex patterns for blocked commands */
    blockedCommands: string[];
    /** Allowed command prefixes (empty = allow all) */
    allowedCommands: string[];
    /** Whether to block network commands */
    blockNetwork: boolean;
  };

  /** File tool security settings */
  file: {
    /** Additional directories allowed for file operations (cwd is always allowed) */
    allowedRoots: string[];
    /** Path patterns to always block */
    blockedPaths: string[];
  };

  /** UI settings */
  ui: {
    /** Color theme */
    theme: 'light' | 'dark' | 'auto';
    /** Show token usage per turn */
    showTokens: boolean;
  };

  /** System prompt additions */
  systemPrompt?: string;
}

const DEFAULT_CONFIG: BrickConfig = {
  defaultProvider: 'openai',
  providers: {},
  extensions: [],
  extensionPaths: [
    './extensions',
    '~/.brick/extensions',
  ],
  shell: {
    allowedDirectories: [],
    timeout: 30_000,
    maxOutputBytes: 1_048_576, // 1 MB
    blockedCommands: [
      'rm\\s+-rf\\s+/\\s*$',
      'rm\\s+-rf\\s+~',
      'rm\\s+-rf\\s+\\.',
      'mkfs\\.\\w+',
      'dd\\s+if=',
      'sudo',
      'su\\s+',
      ':\\s*\\(\\s*\\)\\s*\\{',
    ],
    allowedCommands: [],
    blockNetwork: false,
  },
  file: {
    allowedRoots: [],
    blockedPaths: ['/etc', '/proc', '/sys', '/dev', '/boot'],
  },
  ui: {
    theme: 'auto',
    showTokens: false,
  },
};

export class ConfigManager {
  private config: BrickConfig;

  constructor(overrides?: Partial<BrickConfig>) {
    this.config = this.mergeConfigs(DEFAULT_CONFIG, overrides ?? {});
  }

  get<K extends keyof BrickConfig>(key: K): BrickConfig[K] {
    return this.config[key];
  }

  getProviderConfig(name: string): ProviderConfigEntry {
    return this.config.providers[name] ?? {};
  }

  getAllProviders(): Record<string, ProviderConfigEntry> {
    return { ...this.config.providers };
  }

  /**
   * Load config from environment variables.
   * Env vars take precedence over file config.
   */
  loadFromEnv(): void {
    const envKey = process.env.BRICK_API_KEY;
    const envProvider = process.env.BRICK_PROVIDER;
    const envBaseUrl = process.env.BRICK_BASE_URL;
    const envModel = process.env.BRICK_MODEL;
    const envBlockNetwork = process.env.BRICK_SHELL_BLOCK_NETWORK;

    if (envProvider) {
      this.config.defaultProvider = envProvider;
    }

    const providerName = envProvider ?? this.config.defaultProvider;
    if (envKey || envBaseUrl || envModel) {
      this.config.providers[providerName] = {
        ...this.config.providers[providerName],
        apiKey: envKey ?? this.config.providers[providerName]?.apiKey,
        baseUrl: envBaseUrl ?? this.config.providers[providerName]?.baseUrl,
        defaultModel: envModel ?? this.config.providers[providerName]?.defaultModel,
      };
    }

    if (envBlockNetwork === 'true') {
      this.config.shell = {
        ...this.config.shell,
        blockNetwork: true,
      };
    }
  }

  private mergeConfigs(base: BrickConfig, override: Partial<BrickConfig>): BrickConfig {
    return {
      ...base,
      ...override,
      providers: { ...base.providers, ...(override.providers ?? {}) },
      extensions: [...base.extensions, ...(override.extensions ?? [])],
      extensionPaths: [...base.extensionPaths, ...(override.extensionPaths ?? [])],
      shell: { ...base.shell, ...(override.shell ?? {}) },
      ui: { ...base.ui, ...(override.ui ?? {}) },
      file: { ...base.file, ...(override.file ?? {}) },
    };
  }
}
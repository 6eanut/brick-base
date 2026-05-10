import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigManager, type BrickConfig } from '../config/config.js';

describe('ConfigManager', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    manager = new ConfigManager();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should have default values on construction', () => {
    expect(manager.get('defaultProvider')).toBe('openai');
    expect(manager.get('providers')).toEqual({
      deepseek: { baseUrl: 'https://api.deepseek.com' },
      ollama: { baseUrl: 'http://localhost:11434/v1' },
    });
    expect(manager.get('extensions')).toEqual([]);
    expect(manager.get('extensionPaths')).toEqual([
      './extensions',
      '~/.brick/extensions',
    ]);
    expect(manager.get('shell')).toEqual({
      allowedDirectories: [],
      timeout: 30_000,
      maxOutputBytes: 1_048_576,
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
    });
    expect(manager.get('file')).toEqual({
      allowedRoots: [],
      blockedPaths: ['/etc', '/proc', '/sys', '/dev', '/boot'],
    });
    expect(manager.get('ui')).toEqual({
      theme: 'auto',
      showTokens: false,
    });
  });

  it('should merge overrides correctly', () => {
    const overrides: Partial<BrickConfig> = {
      defaultProvider: 'anthropic',
      shell: {
        allowedDirectories: ['/tmp'],
        timeout: 60_000,
        maxOutputBytes: 2_097_152,
        blockedCommands: [],
        allowedCommands: [],
        blockNetwork: false,
      },
      ui: {
        theme: 'dark',
        showTokens: true,
      },
    };

    const customManager = new ConfigManager(overrides);
    expect(customManager.get('defaultProvider')).toBe('anthropic');
    expect(customManager.get('shell')).toEqual({
      allowedDirectories: ['/tmp'],
      timeout: 60_000,
      maxOutputBytes: 2_097_152,
      blockedCommands: [],
      allowedCommands: [],
      blockNetwork: false,
    });
    expect(customManager.get('ui')).toEqual({
      theme: 'dark',
      showTokens: true,
    });
  });

  it('loadFromEnv should read BRICK_API_KEY, BRICK_PROVIDER, BRICK_BASE_URL, BRICK_MODEL from env', () => {
    vi.stubEnv('BRICK_API_KEY', 'test-api-key');
    vi.stubEnv('BRICK_PROVIDER', 'anthropic');
    vi.stubEnv('BRICK_BASE_URL', 'https://api.anthropic.com');
    vi.stubEnv('BRICK_MODEL', 'claude-sonnet-4-20250514');

    manager.loadFromEnv();

    expect(manager.get('defaultProvider')).toBe('anthropic');
    const providerConfig = manager.getProviderConfig('anthropic');
    expect(providerConfig.apiKey).toBe('test-api-key');
    expect(providerConfig.baseUrl).toBe('https://api.anthropic.com');
    expect(providerConfig.defaultModel).toBe('claude-sonnet-4-20250514');
  });

  it('getProviderConfig should return provider config', () => {
    const overrides: Partial<BrickConfig> = {
      providers: {
        openai: {
          apiKey: 'openai-key',
          baseUrl: 'https://api.openai.com',
          defaultModel: 'gpt-4',
        },
      },
    };

    const customManager = new ConfigManager(overrides);
    const config = customManager.getProviderConfig('openai');

    expect(config.apiKey).toBe('openai-key');
    expect(config.baseUrl).toBe('https://api.openai.com');
    expect(config.defaultModel).toBe('gpt-4');
  });

  it('getProviderConfig should return empty object for unknown provider', () => {
    const config = manager.getProviderConfig('nonexistent');
    expect(config).toEqual({});
  });
});
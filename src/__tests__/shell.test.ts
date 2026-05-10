/**
 * Shell tool tests.
 *
 * Covers: command execution, security sandbox (allowed/blocked commands,
 * allowed directories, blockNetwork), timeout, output limits.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createShellTool } from '../tools/shell.js';
import { execSync } from 'node:child_process';
import type { BrickConfig } from '../config/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const defaultShellConfig: BrickConfig['shell'] = {
  allowedDirectories: [],
  timeout: 30_000,
  maxOutputBytes: 1_048_576,
  blockedCommands: [
    'rm\\s+-rf\\s+/\\s*$',
    'sudo',
    'su\\s+',
  ],
  allowedCommands: [],
  blockNetwork: false,
};

describe('ShellTool', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('executes a simple command and returns output', async () => {
    vi.mocked(execSync).mockReturnValue('hello\n');
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe('hello');
  });

  it('returns error for blocked command (sudo)', async () => {
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: 'sudo rm -rf /' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked');
  });

  it('blocks network commands when blockNetwork is true', async () => {
    const tool = createShellTool({ ...defaultShellConfig, blockNetwork: true });
    const result = await tool.execute({ command: 'curl https://example.com' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('network access is disabled');
  });

  it('returns error on execSync failure', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw { status: 1, stderr: 'command not found', stdout: '' };
    });
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: 'nonexistent' });
    expect(result.success).toBe(false);
  });

  it('respects allowedCommands when set', async () => {
    const tool = createShellTool({ ...defaultShellConfig, allowedCommands: ['echo'] });
    const result = await tool.execute({ command: 'ls' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('allowed');
  });

  it('passes when allowedCommands matches', async () => {
    vi.mocked(execSync).mockReturnValue('hi\n');
    const tool = createShellTool({ ...defaultShellConfig, allowedCommands: ['echo'] });
    const result = await tool.execute({ command: 'echo hi' });
    expect(result.success).toBe(true);
  });

  it('workdir option changes working directory', async () => {
    vi.mocked(execSync).mockReturnValue('/tmp\n');
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: 'pwd', workdir: '/tmp' });
    expect(result.success).toBe(true);
    expect(vi.mocked(execSync).mock.calls[0][1]).toMatchObject({ cwd: '/tmp' });
  });

  it('restricts workdir to allowed directories when configured', async () => {
    const tool = createShellTool({ ...defaultShellConfig, allowedDirectories: ['/tmp'] });
    const result = await tool.execute({ command: 'pwd', workdir: '/etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('allowed');
  });

  it('has correct tool metadata', () => {
    const tool = createShellTool(defaultShellConfig);
    expect(tool.name).toBe('execute_command');
    expect(tool.description).toBeDefined();
    expect(tool.inputSchema).toBeDefined();
  });

  it('respects custom timeout parameter', async () => {
    vi.mocked(execSync).mockReturnValue('done\n');
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: 'sleep 5', timeout: 30_000 });
    expect(result.success).toBe(true);
  });

  it('blocks commands exceeding max length', async () => {
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: 'x'.repeat(10001) });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds maximum length');
  });

  it('blocks commands with too many pipe operators', async () => {
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: 'a|b|c|d|e|f|g|h|i|j|k|l' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds maximum of 10');
  });

  it('blocks dangerous patterns like fork bombs', async () => {
    const tool = createShellTool(defaultShellConfig);
    const result = await tool.execute({ command: ':(){ :|:& };:' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked for security reasons');
  });

  it('handles invalid regex in blockedCommands gracefully', async () => {
    const tool = createShellTool({ ...defaultShellConfig, blockedCommands: ['[invalid' ] });
    vi.mocked(execSync).mockReturnValue('ok\n');
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
  });
});
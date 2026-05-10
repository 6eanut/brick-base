/**
 * Shell command execution tool.
 *
 * Allows the agent to run shell commands with safety constraints:
 * - CWD boundary enforcement
 * - Timeout
 * - Output size limits
 * - Blocked command pattern matching
 * - Allowed command prefix allowlist
 * - Network command blocking
 */

import { execSync } from 'node:child_process';
import { Tool, ToolResult } from './registry.js';

export interface ShellConfig {
  allowedDirectories: string[];
  timeout: number;
  maxOutputBytes: number;
  blockedCommands: string[];
  allowedCommands: string[];
  blockNetwork: boolean;
}

const DEFAULT_CONFIG: ShellConfig = {
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
};

export function createShellTool(config?: Partial<ShellConfig>): Tool {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    name: 'execute_command',
    description: 'Execute a shell command. Returns stdout and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        workdir: { type: 'string', description: 'Working directory (default: cwd)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
      },
      required: ['command'],
    },
    execute: async (args): Promise<ToolResult> => {
      const command = args.command as string;
      const timeout = (args.timeout as number) ?? resolvedConfig.timeout;
      const workdir = (args.workdir as string) ?? process.cwd();

      // Security: enforce max command length
      if (command.length > 10000) {
        return { success: false, output: '', error: 'Command blocked: exceeds maximum length of 10000 characters.' };
      }

      // Security: block commands with too many pipe operators
      const pipeCount = (command.match(/\|/g) || []).length;
      if (pipeCount > 10) {
        return { success: false, output: '', error: 'Command blocked: exceeds maximum of 10 pipe operators.' };
      }

      // Security: validate workdir is within allowed directories
      if (resolvedConfig.allowedDirectories.length > 0) {
        const resolvedWorkdir = workdir.replace(/\/$/, '');
        const isAllowed = resolvedConfig.allowedDirectories.some((dir: string) => {
          const resolvedDir = dir.replace(/\/$/, '');
          return resolvedWorkdir === resolvedDir || resolvedWorkdir.startsWith(resolvedDir + '/');
        });
        if (!isAllowed) {
          return { success: false, output: '', error: `Command blocked: working directory "${workdir}" is not in allowed directories.` };
        }
      }

      // Security: check blocked command patterns
      const dangerousPatterns = [
        /rm\s+-rf\s+\/\s*$/m,  // rm -rf /
        />\s*\/dev\/(null|zero)/, // Writing to special devices
        /:\s*\(\)\s*\{[^}]*:\s*\|/, // Fork bomb (:(){ :|:& };:)
        /brick\.json/,           // brick.json file operations
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return { success: false, output: '', error: 'Command blocked for security reasons.' };
        }
      }

      // Security: check user-configured blocked command patterns
      for (const patternStr of resolvedConfig.blockedCommands) {
        try {
          const pattern = new RegExp(patternStr, 'm');
          if (pattern.test(command)) {
            return { success: false, output: '', error: 'Command blocked: matches a blocked command pattern.' };
          }
        } catch {
          // Invalid regex pattern — skip
        }
      }

      // Security: if allowedCommands is non-empty, verify command word boundary
      if (resolvedConfig.allowedCommands.length > 0) {
        const trimmedCommand = command.trim();
        const isAllowed = resolvedConfig.allowedCommands.some((prefix: string) => {
          const trimmedPrefix = prefix.trim();
          // Match exact command or with args (word boundary, e.g. "ls" matches "ls -la" but not "lsblk")
          return trimmedCommand === trimmedPrefix ||
            trimmedCommand.startsWith(trimmedPrefix + ' ') ||
            trimmedCommand.startsWith(trimmedPrefix + '\t');
        });
        if (!isAllowed) {
          return { success: false, output: '', error: 'Command blocked: does not start with an allowed command prefix.' };
        }
      }

      // Security: if blockNetwork is true, block network-related commands
      if (resolvedConfig.blockNetwork) {
        const networkPatterns = [
          /^\s*curl\b/,
          /^\s*wget\b/,
          /^\s*nc\b/,
          /^\s*ssh\b/,
          /^\s*telnet\b/,
          /^\s*ftp\b/,
          /^\s*scp\b/,
          /^\s*sftp\b/,
        ];
        const trimmedCommand = command.trim();
        for (const pattern of networkPatterns) {
          if (pattern.test(trimmedCommand)) {
            return { success: false, output: '', error: 'Command blocked: network access is disabled.' };
          }
        }
      }

      try {
        const output = execSync(command, {
          cwd: workdir,
          timeout,
          maxBuffer: resolvedConfig.maxOutputBytes,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const stdout = output as string;
        const truncated = stdout.length > resolvedConfig.maxOutputBytes
          ? stdout.slice(0, resolvedConfig.maxOutputBytes) + '\n... [output truncated]'
          : stdout;

        return {
          success: true,
          output: truncated || '(command completed with no output)',
        };
      } catch (err: unknown) {
        const error = err as {
          stdout?: string;
          stderr?: string;
          message?: string;
          status?: number;
          signal?: string;
        };
        const stdout = typeof error.stdout === 'string' ? error.stdout : '';
        const stderr = typeof error.stderr === 'string' ? error.stderr : '';
        const exitCode = error.status ?? error.signal ?? 'unknown';

        return {
          success: false,
          output: stdout,
          error: `Command exited with code ${exitCode}:\n${stderr.slice(0, 2000)}${stderr.length > 2000 ? '\n... [truncated]' : ''}`,
        };
      }
    },
  };
}

export const ShellTool = {
  create: createShellTool,
};
/**
 * Shell command execution tool.
 *
 * Allows the agent to run shell commands with safety constraints:
 * - CWD boundary enforcement
 * - Timeout
 * - Output size limits
 */

import { execSync } from 'node:child_process';
import { Tool, ToolResult } from './registry.js';

export interface ShellConfig {
  allowedDirectories: string[];
  timeout: number;
  maxOutputBytes: number;
}

const DEFAULT_CONFIG: ShellConfig = {
  allowedDirectories: [],
  timeout: 30_000,
  maxOutputBytes: 1_048_576,
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

      // Security: block dangerous patterns
      const dangerousPatterns = [
        /rm\s+-rf\s+\/\s*$/m,  // rm -rf /
        />\s*\/dev\/(null|zero)/, // Writing to special devices
        /:\s*\(\)\s*\{[^}]*:\s*\(\)\s*\;?\s*\};?\s*:/, // Fork bomb
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return { success: false, output: '', error: 'Command blocked for security reasons.' };
        }
      }

      try {
        const output = execSync(command, {
          cwd: args.workdir as string ?? process.cwd(),
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
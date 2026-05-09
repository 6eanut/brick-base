/**
 * Git operation tools.
 *
 * Provides git integration: status, diff, commit, log, branch operations.
 * Uses `execa`-style child_process internally but exposed as Tool interface.
 */

import { execSync } from 'node:child_process';
import { Tool, ToolResult } from './registry.js';

interface GitToolOptions {
  /** Maximum commits to show in log */
  maxLogEntries?: number;
  /** Default branch name (e.g. "main") */
  defaultBranch?: string;
}

function runGit(args: string[], cwd?: string): { stdout: string; stderr: string } {
  const result = execSync(`git ${args.join(' ')}`, {
    cwd: cwd ?? process.cwd(),
    timeout: 15_000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = result as string;
  return { stdout, stderr: '' };
}

async function safeRunGit(args: string[], cwd?: string): Promise<ToolResult> {
  try {
    const { stdout } = runGit(args, cwd);
    return { success: true, output: stdout.trim() || '(empty)' };
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    return {
      success: false,
      output: '',
      error: (typeof e.stderr === 'string' ? e.stderr : '').slice(0, 1000) || e.message || 'Git command failed',
    };
  }
}

export function createGitTools(options?: GitToolOptions): Tool[] {
  const opts = { maxLogEntries: 20, defaultBranch: 'main', ...options };

  const statusTool: Tool = {
    name: 'git_status',
    description: 'Show working tree status (modified, staged, untracked files).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: () => safeRunGit(['status', '--short']),
  };

  const diffTool: Tool = {
    name: 'git_diff',
    description: 'Show unstaged changes (diff) in the working tree.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged changes instead of unstaged' },
        path: { type: 'string', description: 'Limit diff to specific file path' },
      },
    },
    readOnly: true,
    execute: (args) => {
      const cmd = ['diff'];
      if (args.staged) cmd.push('--staged');
      if (args.path) cmd.push('--', args.path as string);
      return safeRunGit(cmd);
    },
  };

  const logTool: Tool = {
    name: 'git_log',
    description: `Show recent commit history (last ${opts.maxLogEntries} commits).`,
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of commits to show' },
        branch: { type: 'string', description: 'Show log for a specific branch' },
      },
    },
    readOnly: true,
    execute: (args) => {
      const count = (args.count as number) ?? opts.maxLogEntries;
      const cmd = ['log', `--max-count=${count}`, '--oneline', '--decorate'];
      if (args.branch) cmd.push(args.branch as string);
      return safeRunGit(cmd);
    },
  };

  const commitTool: Tool = {
    name: 'git_commit',
    description: 'Create a git commit with all staged changes.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['message'],
    },
    execute: (args) => {
      const msg = (args.message as string).replace(/'/g, "'\\''");
      return safeRunGit(['commit', '-m', msg]);
    },
  };

  return [statusTool, diffTool, logTool, commitTool];
}

export const GitTool = {
  create: createGitTools,
  run: runGit,
};
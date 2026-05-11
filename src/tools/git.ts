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
    readOnly: true,
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

  const branchTool: Tool = {
    name: 'git_branch',
    description: 'List, create, or delete branches.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: "list" (default), "create", or "delete"',
          enum: ['list', 'create', 'delete'],
        },
        name: { type: 'string', description: 'Branch name (required for create/delete)' },
      },
    },
    readOnly: true,
    execute: async (args) => {
      const action = (args.action as string) ?? 'list';
      switch (action) {
        case 'create':
          if (!args.name) return { success: false, output: '', error: 'Branch name is required.' };
          return safeRunGit(['branch', args.name as string]);
        case 'delete':
          if (!args.name) return { success: false, output: '', error: 'Branch name is required.' };
          return safeRunGit(['branch', '-d', args.name as string]);
        default:
          return safeRunGit(['branch']);
      }
    },
  };

  const checkoutTool: Tool = {
    name: 'git_checkout',
    description: 'Switch to an existing branch.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to switch to' },
      },
      required: ['branch'],
    },
    execute: async (args) => {
      if (!args.branch) return { success: false, output: '', error: 'Branch name is required.' };
      return safeRunGit(['checkout', args.branch as string]);
    },
  };

  const mergeTool: Tool = {
    name: 'git_merge',
    description: 'Merge a branch into the current branch.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to merge into current branch' },
        message: { type: 'string', description: 'Custom commit message for the merge' },
        squash: { type: 'boolean', description: 'Squash all commits into one' },
      },
      required: ['branch'],
    },
    execute: async (args) => {
      if (!args.branch) return { success: false, output: '', error: 'Branch name is required.' };
      const cmd = ['merge'];
      if (args.squash) cmd.push('--squash');
      if (args.message) {
        const msg = (args.message as string).replace(/'/g, "'\\''");
        cmd.push('-m', msg);
      }
      cmd.push(args.branch as string);
      return safeRunGit(cmd);
    },
  };

  const rebaseTool: Tool = {
    name: 'git_rebase',
    description: 'Rebase current branch onto another branch.',
    inputSchema: {
      type: 'object',
      properties: {
        onto: { type: 'string', description: 'Branch to rebase onto' },
        interactive: { type: 'boolean', description: 'Use interactive rebase' },
      },
      required: ['onto'],
    },
    execute: async (args) => {
      if (!args.onto) return { success: false, output: '', error: 'Target branch is required.' };
      const cmd = ['rebase'];
      if (args.interactive) cmd.push('--interactive');
      cmd.push(args.onto as string);
      return safeRunGit(cmd);
    },
  };

  return [statusTool, diffTool, logTool, commitTool, branchTool, checkoutTool, mergeTool, rebaseTool];
}

export const GitTool = {
  create: createGitTools,
  run: runGit,
};
/**
 * Git tool tests.
 *
 * Covers: git_status, git_diff, git_log, git_commit, error handling via safeRunGit.
 * Uses mocked execSync from node:child_process.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockExecSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

import { createGitTools } from '../tools/git.js';

describe('GitTool', () => {
  let tools: ReturnType<typeof createGitTools>;
  let statusTool: (typeof tools)[0];
  let diffTool: (typeof tools)[1];
  let logTool: (typeof tools)[2];
  let commitTool: (typeof tools)[3];
  let branchTool: (typeof tools)[4];
  let checkoutTool: (typeof tools)[5];
  let mergeTool: (typeof tools)[6];
  let rebaseTool: (typeof tools)[7];

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createGitTools();
    statusTool = tools[0];
    diffTool = tools[1];
    logTool = tools[2];
    commitTool = tools[3];
    branchTool = tools[4];
    checkoutTool = tools[5];
    mergeTool = tools[6];
    rebaseTool = tools[7];
  });

  describe('git_status', () => {
    it('returns working tree status', async () => {
      mockExecSync.mockReturnValue(' M src/index.ts\n?? newfile.txt\n');
      const result = await statusTool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('M src/index.ts');
      expect(result.output).toContain('newfile.txt');
    });

    it('returns (empty) when status is clean', async () => {
      mockExecSync.mockReturnValue('');
      const result = await statusTool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toBe('(empty)');
    });

    it('handles git errors gracefully', async () => {
      mockExecSync.mockImplementation(() => {
        const err = new Error('fatal: not a git repository') as any;
        err.stderr = 'fatal: not a git repository';
        throw err;
      });
      const result = await statusTool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a git repository');
    });
  });

  describe('git_diff', () => {
    it('shows unstaged changes', async () => {
      mockExecSync.mockReturnValue('diff --git a/src/index.ts b/src/index.ts\n+new line\n');
      const result = await diffTool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('+new line');
    });

    it('shows staged changes when staged=true', async () => {
      mockExecSync.mockReturnValue('diff --git a/src/index.ts b/src/index.ts\n+staged change\n');
      const result = await diffTool.execute({ staged: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain('staged change');
      // Verify --staged flag was passed
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('diff');
      expect(cmd).toContain('--staged');
    });

    it('limits diff to specific path', async () => {
      mockExecSync.mockReturnValue('diff for file.ts\n');
      const result = await diffTool.execute({ path: 'src/file.ts' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('--');
      expect(cmd).toContain('src/file.ts');
    });
  });

  describe('git_log', () => {
    it('shows recent commits', async () => {
      mockExecSync.mockReturnValue('abc1234 Fix bug\nbcd2345 Add feature\n');
      const result = await logTool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('abc1234');
      expect(result.output).toContain('bcd2345');
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('--max-count=20');
    });

    it('respects custom count', async () => {
      mockExecSync.mockReturnValue('abc1234 Commit\n');
      const result = await logTool.execute({ count: 5 });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('--max-count=5');
    });

    it('shows log for specific branch', async () => {
      mockExecSync.mockReturnValue('def3456 Branch commit\n');
      const result = await logTool.execute({ branch: 'feature-x' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('feature-x');
    });
  });

  describe('git_commit', () => {
    it('creates a commit with message', async () => {
      mockExecSync.mockReturnValue('[main abc1234] My message\n');
      const result = await commitTool.execute({ message: 'My message' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('My message');
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('commit');
      expect(cmd).toContain('-m');
    });

    it('escapes single quotes in commit message', async () => {
      mockExecSync.mockReturnValue('[main def5678] It worked\n');
      const result = await commitTool.execute({ message: "Don't break" });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      // The quote should be escaped
      expect(cmd).not.toContain("Don't");
    });

    it('handles commit failure', async () => {
      mockExecSync.mockImplementation(() => {
        const err = new Error('nothing to commit') as any;
        err.stderr = 'nothing to commit, working tree clean';
        throw err;
      });
      const result = await commitTool.execute({ message: 'empty' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('nothing to commit');
    });
  });

  describe('custom options', () => {
    it('uses custom maxLogEntries', () => {
      const customTools = createGitTools({ maxLogEntries: 5, defaultBranch: 'develop' });
      expect(customTools).toHaveLength(8);
    });
  });

  describe('tool metadata', () => {
    it('statusTool has correct metadata', () => {
      expect(statusTool.name).toBe('git_status');
      expect(statusTool.description).toBeDefined();
    });

    it('diffTool has correct metadata', () => {
      expect(diffTool.name).toBe('git_diff');
      expect(diffTool.description).toBeDefined();
      expect(diffTool.readOnly).toBe(true);
    });

    it('logTool has correct metadata', () => {
      expect(logTool.name).toBe('git_log');
      expect(logTool.description).toBeDefined();
      expect(logTool.readOnly).toBe(true);
    });

    it('commitTool has correct metadata', () => {
      expect(commitTool.name).toBe('git_commit');
      expect(commitTool.description).toBeDefined();
    });

    it('branchTool has correct metadata', () => {
      expect(branchTool.name).toBe('git_branch');
      expect(branchTool.description).toBeDefined();
      expect(branchTool.readOnly).toBe(true);
    });

    it('checkoutTool has correct metadata', () => {
      expect(checkoutTool.name).toBe('git_checkout');
      expect(checkoutTool.description).toBeDefined();
    });

    it('mergeTool has correct metadata', () => {
      expect(mergeTool.name).toBe('git_merge');
      expect(mergeTool.description).toBeDefined();
    });

    it('rebaseTool has correct metadata', () => {
      expect(rebaseTool.name).toBe('git_rebase');
      expect(rebaseTool.description).toBeDefined();
    });
  });

  describe('git_branch', () => {
    it('lists branches by default', async () => {
      mockExecSync.mockReturnValue('* main\n  feature-x\n');
      const result = await branchTool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('main');
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toBe('git branch');
    });

    it('creates a new branch', async () => {
      mockExecSync.mockReturnValue('');
      const result = await branchTool.execute({ action: 'create', name: 'feature-y' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toBe('git branch feature-y');
    });

    it('deletes a branch', async () => {
      mockExecSync.mockReturnValue('Deleted branch feature-x');
      const result = await branchTool.execute({ action: 'delete', name: 'feature-x' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toBe('git branch -d feature-x');
    });

    it('returns error when name missing for create', async () => {
      const result = await branchTool.execute({ action: 'create' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Branch name is required');
    });

    it('returns error when name missing for delete', async () => {
      const result = await branchTool.execute({ action: 'delete' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Branch name is required');
    });
  });

  describe('git_checkout', () => {
    it('switches to a branch', async () => {
      mockExecSync.mockReturnValue('Switched to branch feature-x');
      const result = await checkoutTool.execute({ branch: 'feature-x' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toBe('git checkout feature-x');
    });

    it('returns error when branch missing', async () => {
      const result = await checkoutTool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Branch name is required');
    });
  });

  describe('git_merge', () => {
    it('merges a branch', async () => {
      mockExecSync.mockReturnValue('Merge made by recursive');
      const result = await mergeTool.execute({ branch: 'feature-x' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toBe('git merge feature-x');
    });

    it('merges with squash', async () => {
      mockExecSync.mockReturnValue('Squash merge done');
      const result = await mergeTool.execute({ branch: 'feature-x', squash: true });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('--squash');
    });

    it('merges with custom message', async () => {
      mockExecSync.mockReturnValue('Merge successful');
      const result = await mergeTool.execute({ branch: 'feature-x', message: 'Merge feature' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('-m');
    });

    it('returns error when branch missing', async () => {
      const result = await mergeTool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Branch name is required');
    });
  });

  describe('git_rebase', () => {
    it('rebases onto a branch', async () => {
      mockExecSync.mockReturnValue('Successfully rebased');
      const result = await rebaseTool.execute({ onto: 'main' });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toBe('git rebase main');
    });

    it('rebases with interactive flag', async () => {
      mockExecSync.mockReturnValue('Interactive rebase done');
      const result = await rebaseTool.execute({ onto: 'main', interactive: true });
      expect(result.success).toBe(true);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain('--interactive');
    });

    it('returns error when onto missing', async () => {
      const result = await rebaseTool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target branch is required');
    });
  });
});
/**
 * File operation tools — read, write, edit, grep, glob.
 *
 * All file operations are guarded by path security checks:
 * - Symlink traversal protection via realpathSync
 * - Blocked system paths (always enforced)
 * - Configurable blocked paths (from config.file.blockedPaths)
 * - Allowed root directories (cwd + config.file.allowedRoots)
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { Tool, ToolResult } from './registry.js';

let allowedRoots: string[] = [process.cwd()];
let blockedPaths: string[] = [];

export function setAllowedRoots(roots: string[]): void {
  allowedRoots = [...roots];
}

export function getAllowedRoots(): string[] {
  return [...allowedRoots];
}

export function setBlockedPaths(paths: string[]): void {
  blockedPaths = [...paths];
}

export function getBlockedPaths(): string[] {
  return [...blockedPaths];
}

function isPathAllowed(targetPath: string): boolean {
  // Resolve symlinks first to prevent symlink traversal bypass
  let resolved: string;
  try {
    resolved = realpathSync(targetPath);
  } catch {
    // If realpath fails (e.g., file doesn't exist yet), fall back to resolve
    resolved = resolve(targetPath);
  }

  // Block access to sensitive system paths (always enforced)
  const defaultBlockedPatterns = [
    /^\/etc\//,
    /^\/proc\//,
    /^\/sys\//,
    /^\/dev\//,
    /^\/boot\//,
    /^\/var\/log/,
    /^\/run\//,
    /\/\.ssh\//,
    /\/\.aws\//,
    /\/\.config\//,
    /\/\.git\//,
    /\/node_modules\//,
  ];

  for (const pattern of defaultBlockedPatterns) {
    if (pattern.test(resolved)) {
      return false;
    }
  }

  // Block paths from config (config.file.blockedPaths)
  for (const blockedPath of blockedPaths) {
    const normalizedBlocked = resolve(blockedPath);
    if (resolved === normalizedBlocked || resolved.startsWith(normalizedBlocked + sep)) {
      return false;
    }
  }

  // Check if path is within any allowed root
  for (const root of allowedRoots) {
    const normalizedRoot = resolve(root);
    if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep)) {
      return true;
    }
  }

  return false;
}

/**
 * Read a file with optional line range.
 */
const readTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file, optionally specifying a range of lines.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (absolute or relative to cwd)' },
      offset: { type: 'number', description: 'Starting line (1-based, optional)' },
      limit: { type: 'number', description: 'Maximum lines to read (optional)' },
    },
    required: ['path'],
  },
  readOnly: true,
  execute: async (args) => {
    const filePath = resolve(args.path as string);
    if (!isPathAllowed(filePath)) {
      return { success: false, output: '', error: 'Path not allowed for security reasons.' };
    }
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const offset = (args.offset as number) ?? 1;
    const limit = args.limit as number | undefined;
    const selected = limit ? lines.slice(offset - 1, offset - 1 + limit) : lines.slice(offset - 1);

    return {
      success: true,
      output: selected.join('\n'),
      data: { totalLines: lines.length, path: filePath },
    };
  },
};

/**
 * Write content to a file (creates directories if needed).
 */
const writeTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file. Creates parent directories if they do not exist.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const filePath = resolve(args.path as string);
    if (!isPathAllowed(filePath)) {
      return { success: false, output: '', error: 'Path not allowed for security reasons.' };
    }
    const dir = filePath.split(sep).slice(0, -1).join(sep);
    if (dir && !existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(filePath, args.content as string, 'utf-8');
    return { success: true, output: `Written ${(args.content as string).length} bytes to ${filePath}` };
  },
};

/**
 * Search files using a regex pattern.
 */
const grepTool: Tool = {
  name: 'grep_search',
  description: 'Search files using a regular expression pattern. Returns matching file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search in (default: cwd)' },
      maxResults: { type: 'number', description: 'Maximum results to return (default: 50)' },
    },
    required: ['pattern'],
  },
  readOnly: true,
  execute: async (args) => {
    const pattern = new RegExp(args.pattern as string);
    const searchPath = resolve((args.path as string) ?? '.');
    if (!isPathAllowed(searchPath)) {
      return { success: false, output: '', error: 'Path not allowed for security reasons.' };
    }
    const maxResults = (args.maxResults as number) ?? 50;
    const results: string[] = [];

    async function searchDir(dir: string): Promise<void> {
      if (results.length >= maxResults) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else if (entry.isFile()) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (pattern.test(lines[i])) {
                const relPath = relative(process.cwd(), fullPath);
                results.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    await searchDir(searchPath);
    return {
      success: true,
      output: results.length > 0 ? results.join('\n') : 'No matches found.',
      data: { results, count: results.length },
    };
  },
};

/**
 * List files matching a glob-like pattern (simple prefix matching).
 */
const globTool: Tool = {
  name: 'list_files',
  description: 'List files in a directory, optionally filtering by pattern.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list' },
      pattern: { type: 'string', description: 'Optional filename pattern to filter (e.g. "*.ts")' },
      recursive: { type: 'boolean', description: 'List recursively (default: false)' },
    },
    required: ['path'],
  },
  readOnly: true,
  execute: async (args) => {
    const dirPath = resolve(args.path as string);
    if (!isPathAllowed(dirPath)) {
      return { success: false, output: '', error: 'Path not allowed for security reasons.' };
    }
    const recursive = args.recursive as boolean ?? false;
    const pattern = args.pattern as string | undefined;
    const results: string[] = [];

    async function listDir(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = `${dir}/${entry.name}`;
        const relPath = relative(process.cwd(), fullPath);
        if (entry.isDirectory()) {
          results.push(`${relPath}/`);
          if (recursive) await listDir(fullPath);
        } else if (entry.isFile()) {
          if (!pattern || entry.name.endsWith(pattern.slice(1))) {
            results.push(relPath);
          }
        }
      }
    }

    await listDir(dirPath);
    return {
      success: true,
      output: results.join('\n'),
      data: { files: results, count: results.length },
    };
  },
};

/** Get file stat info */
const statTool: Tool = {
  name: 'file_stat',
  description: 'Get file or directory metadata (size, modification time, type).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file or directory' },
    },
    required: ['path'],
  },
  readOnly: true,
  execute: async (args) => {
    const filePath = resolve(args.path as string);
    if (!isPathAllowed(filePath)) {
      return { success: false, output: '', error: 'Path not allowed for security reasons.' };
    }
    const s = await stat(filePath);
    return {
      success: true,
      output: [
        `Path: ${filePath}`,
        `Size: ${s.size} bytes`,
        `Type: ${s.isDirectory() ? 'directory' : 'file'}`,
        `Modified: ${s.mtime.toISOString()}`,
      ].join('\n'),
    };
  },
};

export const FileTool = {
  read: readTool,
  write: writeTool,
  grep: grepTool,
  glob: globTool,
  stat: statTool,

  /** Register all file tools into a registry */
  registerAll(registry: { register: (tool: Tool, category?: string) => void }): void {
    registry.register(readTool);
    registry.register(writeTool);
    registry.register(grepTool);
    registry.register(globTool);
    registry.register(statTool);
  },
};
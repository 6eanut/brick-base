/**
 * MCP Bridge tests.
 *
 * Covers: connect (initialization, tool listing), disconnect, tool execution,
 * error handling (timeout, process exit, bad JSON-RPC responses).
 * All subprocess and readline interactions are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpBridge } from '../extensions/mcp-bridge.js';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockCreateInterface = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('node:readline', () => ({
  createInterface: mockCreateInterface,
}));

const extension = {
  manifest: {
    name: 'repomap',
    version: '1.0.0',
    description: 'Repo mapping',
    type: 'mcp' as const,
    mcp: { command: 'node', args: ['server.js'] },
    capabilities: { tools: ['map'], commands: [], hooks: [] },
  },
  path: '/ext/repomap',
  enabled: true,
  installedAt: '2026-01-01T00:00:00Z',
};

describe('McpBridge', () => {
  let bridge: McpBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockCreateInterface.mockReset();
    bridge = new McpBridge();
  });

  describe('connect', () => {
    it('connects to MCP server and returns tools', async () => {
      const stderr = { on: vi.fn() };
      const stdout = { pipe: vi.fn() };
      const proc = { stdin: { write: vi.fn() }, stdout, stderr, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));

      const connectPromise = bridge.connect(extension);

      // Simulate initialization response
      setTimeout(() => {
        lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: { protocolVersion: '2025-03-26' } }));
        // Simulate tools/list response
        setTimeout(() => {
          lineCb!(JSON.stringify({
            jsonrpc: '2.0', id: 'brick-2',
            result: { tools: [{ name: 'map', description: 'Map a repo', inputSchema: { type: 'object', properties: {} } }] },
          }));
        }, 10);
      }, 10);

      const tools = await connectPromise;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('repomap__map');
      expect(tools[0].description).toBe('Map a repo');
      expect(mockSpawn).toHaveBeenCalledWith('node', ['server.js'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.any(Object),
        cwd: '/ext/repomap',
      });
    });

    it('throws when process exits during initialization', async () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      let exitCb: ((code: number) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));
      proc.on = vi.fn((_e: string, cb: (code: number) => void) => { exitCb = cb; });

      const connectPromise = bridge.connect(extension);

      // Process exits before responding to initialize
      setTimeout(() => exitCb!(1), 5);

      await expect(connectPromise).rejects.toThrow('exited with code 1');
      expect(proc.kill).toHaveBeenCalled(); // catch block in connect() calls kill()
    });
  });

  describe('disconnect', () => {
    it('kills the MCP process', () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));

      bridge.connect(extension);
      bridge.disconnect('repomap');
      expect(proc.kill).toHaveBeenCalled();
    });

    it('disconnectAll kills all processes', () => {
      const proc1 = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      const proc2 = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

      let lc1: ((l: string) => void) | undefined;
      let lc2: ((l: string) => void) | undefined;
      mockCreateInterface
        .mockImplementationOnce(() => ({ on: (_e: string, cb: (l: string) => void) => { lc1 = cb; } }))
        .mockImplementationOnce(() => ({ on: (_e: string, cb: (l: string) => void) => { lc2 = cb; } }));

      bridge.connect(extension);
      bridge.connect({ ...extension, manifest: { ...extension.manifest, name: 'web-search' } });

      bridge.disconnectAll();
      expect(proc1.kill).toHaveBeenCalled();
      expect(proc2.kill).toHaveBeenCalled();
    });
  });

  describe('tool execution', () => {
    it('executes MCP tool and returns result', async () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));

      const connectPromise = bridge.connect(extension);
      setTimeout(() => {
        lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: {} }));
        setTimeout(() => {
          lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-2', result: { tools: [{ name: 'map' }] } }));
        }, 10);
      }, 10);

      const tools = await connectPromise;
      const tool = tools[0];

      const execPromise = tool.execute({ path: '/src' });
      setTimeout(() => {
        lineCb!(JSON.stringify({
          jsonrpc: '2.0', id: 'brick-3',
          result: { content: [{ type: 'text', text: 'Mapped repo' }] },
        }));
      }, 10);

      const result = await execPromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe('Mapped repo');
    });

    it('handles MCP tool error response', async () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));

      const connectPromise = bridge.connect(extension);
      setTimeout(() => {
        lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: {} }));
        setTimeout(() => {
          lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-2', result: { tools: [{ name: 'map' }] } }));
        }, 10);
      }, 10);

      const tools = await connectPromise;
      const tool = tools[0];

      const execPromise = tool.execute({});
      setTimeout(() => {
        lineCb!(JSON.stringify({
          jsonrpc: '2.0', id: 'brick-3',
          error: { code: -32603, message: 'Internal error' },
        }));
      }, 10);

      const result = await execPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Internal error');
    });

    it('handles tool execution with empty content array', async () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));

      const connectPromise = bridge.connect(extension);
      setTimeout(() => {
        lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: {} }));
        setTimeout(() => {
          lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-2', result: { tools: [{ name: 'map' }] } }));
        }, 10);
      }, 10);

      const tools = await connectPromise;
      const tool = tools[0];

      const execPromise = tool.execute({});
      setTimeout(() => {
        lineCb!(JSON.stringify({
          jsonrpc: '2.0', id: 'brick-3',
          result: { content: [] },
        }));
      }, 10);

      const result = await execPromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe('(tool completed with no output)');
    });
  });

  describe('process exit handling', () => {
    it('rejects pending requests when process exits', async () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      let exitCb: ((code: number) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));
      proc.on = vi.fn((_e: string, cb: (code: number) => void) => { exitCb = cb; });

      const connectPromise = bridge.connect(extension);
      setTimeout(() => {
        lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: {} }));
        setTimeout(() => {
          lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-2', result: { tools: [{ name: 'map' }] } }));
        }, 10);
      }, 10);

      const tools = await connectPromise;
      const tool = tools[0];

      const execPromise = tool.execute({});
      exitCb!(1);

      const result = await execPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('exited with code 1');
    });
  });

  describe('JSON-RPC parsing edge cases', () => {
    it('handles partial JSON in buffer (multiple chunks)', async () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));

      const connectPromise = bridge.connect(extension);

      setTimeout(() => {
        lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: {} }).slice(0, 20));
        setTimeout(() => {
          lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: {} }).slice(20));
          setTimeout(() => {
            lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-2', result: { tools: [{ name: 'map' }] } }));
          }, 10);
        }, 10);
      }, 10);

      const tools = await connectPromise;
      expect(tools).toHaveLength(1);
    });
  });

  describe('request timeout and disconnect guard', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('times out when tool server does not respond', async () => {
      const proc = { stdin: { write: vi.fn() }, stdout: { pipe: vi.fn() }, stderr: { on: vi.fn() }, kill: vi.fn(), on: vi.fn() };
      mockSpawn.mockReturnValue(proc);

      let lineCb: ((line: string) => void) | undefined;
      mockCreateInterface.mockImplementation(() => ({
        on: (_e: string, cb: (l: string) => void) => { lineCb = cb; },
      }));

      // Start connect
      const connectPromise = bridge.connect(extension);
      // Advance past 50ms to fire initialize response, then 100ms more for tools/list
      await vi.advanceTimersByTimeAsync(200);
      lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-1', result: {} }));
      await vi.advanceTimersByTimeAsync(100);
      lineCb!(JSON.stringify({ jsonrpc: '2.0', id: 'brick-2', result: { tools: [{ name: 'map' }] } }));
      await vi.advanceTimersByTimeAsync(100);

      const tools = await connectPromise;

      // Execute tool but never respond — timeout after 30s
      const execPromise = tools[0].execute({});
      await vi.advanceTimersByTimeAsync(31_000);

      const result = await execPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });
});
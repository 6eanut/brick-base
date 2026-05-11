/**
 * MCP Bridge.
 *
 * Bridges Brick's tool system with MCP (Model Context Protocol) servers.
 * Each extension runs as an MCP server subprocess. The bridge:
 * 1. Starts the MCP server process
 * 2. Initializes via stdio-based JSON-RPC
 * 3. Lists available tools
 * 4. Proxies tool calls between Brick and the MCP server
 *
 * MCP Protocol: https://spec.modelcontextprotocol.io/
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BRICK_VERSION } from './compatibility.js';
import type { ExtensionState } from './registry.js';
import { Tool, ToolResult } from '../tools/registry.js';

interface MCPRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpBridge {
  private processes: Map<string, ChildProcess> = new Map();
  private pendingRequests: Map<string, { resolve: (v: MCPResponse) => void; reject: (e: Error) => void }> = new Map();
  private requestCounter = 0;

  /**
   * Start an MCP server for an extension and return the tools it exposes.
   */
  async connect(extension: ExtensionState): Promise<Tool[]> {
    const manifest = extension.manifest;
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...manifest.mcp.env,
    };

    const proc = spawn(manifest.mcp.command, manifest.mcp.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env as Record<string, string>,
      cwd: extension.path,
    });

    this.processes.set(manifest.name, proc);

    // Handle stdout: JSON-RPC responses
    const rl = createInterface({ input: proc.stdout! });
    let buffer = '';

    rl.on('line', (line) => {
      buffer += line;
      try {
        const response = JSON.parse(buffer) as MCPResponse;
        buffer = '';
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          pending.resolve(response);
          this.pendingRequests.delete(response.id);
        }
      } catch {
        // Incomplete JSON, wait for more data
      }
    });

    // Handle stderr for debugging
    proc.stderr?.on('data', (_data: Buffer) => {
      // MCP servers sometimes log to stderr — ignored by default
    });

    // Handle unexpected exit
    proc.on('exit', (code) => {
      this.processes.delete(manifest.name);
      // Reject all pending requests for this process
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server "${manifest.name}" exited with code ${code}`));
        this.pendingRequests.delete(id);
      }
    });

    // Initialize
    try {
      await this.sendRequest(manifest.name, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'brick', version: BRICK_VERSION },
      });
    } catch (err) {
      proc.kill();
      throw new Error(`Failed to initialize MCP server "${manifest.name}": ${err}`);
    }

    // List tools
    const toolsResponse = await this.sendRequest(manifest.name, 'tools/list');
    const tools = (toolsResponse.result as { tools?: MCPTool[] })?.tools ?? [];

    // Convert MCP tools to Brick Tool interface
    return tools.map((mcpTool: MCPTool) => this.mcpToolToBrickTool(manifest.name, mcpTool));
  }

  /**
   * Disconnect (stop) an extension's MCP server.
   */
  disconnect(name: string): void {
    const proc = this.processes.get(name);
    if (proc) {
      proc.kill();
      this.processes.delete(name);
    }
  }

  /**
   * Disconnect all MCP servers.
   */
  disconnectAll(): void {
    for (const [name] of this.processes) {
      this.disconnect(name);
    }
  }

  private async sendRequest(extensionName: string, method: string, params?: Record<string, unknown>): Promise<MCPResponse> {
    const id = `brick-${++this.requestCounter}`;
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const proc = this.processes.get(extensionName);
    if (!proc || !proc.stdin) {
      throw new Error(`MCP server "${extensionName}" is not connected`);
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      proc.stdin!.write(JSON.stringify(request) + '\n');

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request "${method}" to "${extensionName}" timed out`));
        }
      }, 30_000);
    });
  }

  private mcpToolToBrickTool(extensionName: string, mcpTool: MCPTool): Tool {
    // Namespace the tool to avoid conflicts
    const namespacedName = `${extensionName}__${mcpTool.name}`;

    return {
      name: namespacedName,
      description: mcpTool.description ?? `Tool provided by ${extensionName}`,
      inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
      execute: async (args) => {
        try {
          const response = await this.sendRequest(extensionName, 'tools/call', {
            name: mcpTool.name,
            arguments: args,
          });

          if (response.error) {
            return {
              success: false,
              output: '',
              error: `MCP tool "${mcpTool.name}" error: ${response.error.message}`,
            };
          }

          const result = response.result as { content?: Array<{ type: string; text?: string }> };
          const textContent = result?.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n') ?? '';

          return { success: true, output: textContent || '(tool completed with no output)' };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, output: '', error: message };
        }
      },
    };
  }
}
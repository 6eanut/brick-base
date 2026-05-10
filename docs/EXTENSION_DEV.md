# Brick Extension Developer Guide

This guide explains how to create extensions for Brick — the modular AI coding agent.

## What is an Extension?

An extension is an MCP (Model Context Protocol) server that runs as a subprocess and communicates with Brick via JSON-RPC over stdio. Extensions provide tools that the LLM can discover and call.

## Quick Start

### 1. Create the directory structure

```
my-extension/
├── brick.json       # Extension manifest
├── index.js         # MCP server (ESM, Node 20+)
├── package.json     # npm package metadata
└── README.md        # Documentation
```

### 2. Write the manifest (`brick.json`)

```json
{
  "name": "my-extension",
  "version": "0.1.0",
  "description": "What my extension does",
  "type": "mcp",
  "mcp": {
    "command": "node",
    "args": ["index.js"]
  },
  "capabilities": {
    "tools": ["my_tool"],
    "commands": [],
    "hooks": []
  }
}
```

### 3. Write the MCP server (`index.js`)

```javascript
import { createInterface } from 'node:readline';

// JSON-RPC 2.0 over stdio
const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  const request = JSON.parse(line);
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      console.log(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'my-extension', version: '0.1.0' } },
      }));
      break;

    case 'tools/list':
      console.log(JSON.stringify({
        jsonrpc: '2.0', id,
        result: {
          tools: [
            {
              name: 'my_tool',
              description: 'What my tool does',
              inputSchema: {
                type: 'object',
                properties: {
                  param1: { type: 'string', description: 'First parameter' },
                },
                required: ['param1'],
              },
            },
          ],
        },
      }));
      break;

    case 'tools/call':
      const { name, arguments: args } = params;
      if (name === 'my_tool') {
        const result = `Hello, ${args.param1}!`;
        console.log(JSON.stringify({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: result }] },
        }));
      }
      break;

    default:
      console.log(JSON.stringify({
        jsonrpc: '2.0', id,
        result: {},
      }));
  }
}
```

### 4. Write `package.json`

```json
{
  "name": "@brick/extension-my-extension",
  "version": "0.1.0",
  "description": "Brick extension: ...",
  "type": "module",
  "main": "index.js",
  "license": "MIT"
}
```

### 5. Install and test

```bash
# Local install
brick install ./my-extension

# Start Brick — extension auto-loads
brick

# Check it's loaded
/extensions
/tools
```

## MCP Protocol Reference

Brick's MCP bridge implements these JSON-RPC methods:

| Method | When Called | Purpose |
|--------|-----------|---------|
| `initialize` | On connect | Version negotiation, capability exchange |
| `notifications/initialized` | After initialize | Signal that init is complete |
| `tools/list` | On connect | Discover available tools |
| `tools/call` | On tool use | Execute a tool with arguments |

### Request Format

```json
{"jsonrpc": "2.0", "id": "brick-1", "method": "tools/list"}
{"jsonrpc": "2.0", "id": "brick-2", "method": "tools/call", "params": {"name": "my_tool", "arguments": {"param1": "world"}}}
```

### Response Format

```json
{"jsonrpc": "2.0", "id": "brick-1", "result": {"tools": [...]}}
{"jsonrpc": "2.0", "id": "brick-2", "result": {"content": [{"type": "text", "text": "Hello, world!"}]}}
```

## Tool Definition Schema

Each tool in `tools/list` response should have:

```json
{
  "name": "tool_name",
  "description": "Clear description of what the tool does",
  "inputSchema": {
    "type": "object",
    "properties": {
      "param_name": {
        "type": "string",
        "description": "Parameter description"
      }
    },
    "required": ["param_name"]
  }
}
```

## Best Practices

1. **Zero dependencies**: Use Node.js 20+ built-ins (`fetch`, `fs`, `path`, `readline`). No npm install needed.
2. **Robust error handling**: Return descriptive errors via `tools/call` response, don't crash.
3. **Resource cleanup**: Handle `SIGTERM` and close file handles if needed.
4. **Timeouts**: Use `AbortController` for network requests (10s default suggested).
5. **Stateless**: Each tool call is independent — don't rely on in-memory state.
6. **Streaming responses**: Return `content` array with text items. Binary content not yet supported.

## Example Extensions

See the official extensions for reference:
- [brick-web-search](https://github.com/brick-codeagent/brick-web-search) — Web search via DuckDuckGo
- [brick-repomap](https://github.com/brick-codeagent/brick-repomap) — Codebase mapping and symbol search
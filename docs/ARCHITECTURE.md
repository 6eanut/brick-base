# Brick Architecture

## Overview

Brick is a modular AI coding agent. The core (`brick-base`) provides CLI, agent loop, file/shell/git tools, and an MCP bridge. Features plug in as extensions via MCP stdio servers.

## Architecture Diagram

```
User Input → CLI/REPL → Agent Loop → LLM API (OpenAI-compatible)
                                      ↓
                            Tool Registry
                                      ↓
                    ┌── Built-in: file, shell, git
                    ├── Extensions: via MCP Bridge
                    └── Slash Commands
```

## Component Breakdown

### 1. CLI Layer (`src/cli.ts`)

Entry point using Commander. Responsibilities:
- Parse CLI args (`--model`, `--plan`, `--no-extensions`, etc.)
- Load config from env vars and config files
- Initialize LLM provider, tool registry, extension registry
- Start the REPL (readline-based interactive loop)
- Route input to slash commands or agent loop
- Display progress visualization during execution

### 2. Agent Loop (`src/agent/loop.ts`)

The core ReAct (Reasoning + Acting) loop:

1. Receive user input
2. Build message list from conversation history + tool definitions
3. Call LLM API
4. If LLM requests tool calls → execute each tool → feed results back → go to step 2
5. If LLM returns text → present as final response
6. Loop terminates after 20 turns max

**Events** (for progress visualization):
- `turn_start`, `llm_request`, `llm_response`, `tool_call`, `tool_result`, `turn_end`, `final_response`, `error`

### 3. LLM Provider (`src/llm/provider.ts`)

Abstraction layer for LLM API calls:
- Supports any OpenAI-compatible API (OpenAI, LiteLLM, DeepSeek, etc.)
- Configurable via `BRICK_API_KEY`, `BRICK_BASE_URL`, `BRICK_PROVIDER`, `BRICK_MODEL`
- Tool/function calling support
- Configurable streaming capability (not yet implemented)

### 4. Tool Registry (`src/tools/registry.ts`)

Central registry for all tools:
- **Built-in**: FileTool (read/write/edit/grep/glob/ls), ShellTool (execute commands), GitTool (status/diff/commit/log)
- **Extension tools**: Loaded dynamically via MCP Bridge, namespaced as `{extName}__{toolName}`
- Tools are categorized as built-in or per-extension

### 5. Extension System

**Extension Registry** (`src/extensions/registry.ts`):
- Scans `~/.brick/extensions/` and `./extensions/` for `brick.json` manifests
- Manages lifecycle: discovery, registration, enable/disable

**MCP Bridge** (`src/extensions/mcp-bridge.ts`):
- Spawns each extension as a child process
- Communicates via JSON-RPC 2.0 over stdio
- Implements MCP protocol: `initialize`, `tools/list`, `tools/call`
- Wraps MCP tools into Brick's Tool interface with namespaced names

### 6. Configuration (`src/config/config.ts`)

Multi-layer configuration:
```
CLI args > Environment variables > Config file > Defaults
```

Key env vars: `BRICK_API_KEY`, `BRICK_PROVIDER`, `BRICK_BASE_URL`, `BRICK_MODEL`

### 7. Conversation & Context Management

**ConversationManager** (`src/agent/conversation.ts`):
- Manages message history (system, user, assistant, tool messages)
- Supports multiple concurrent conversations

**ContextManager** (`src/agent/context.ts`):
- Token counting (approximate: chars/4)
- Message truncation when approaching context limits
- Keeps system prompt + recent messages

### 8. Command System (`src/commands/registry.ts`)

Slash commands available in REPL: `/help`, `/mode`, `/model`, `/tools`, `/extensions`, `/clear`, `/exit`, `/quit`

## Extension Protocol

Each extension is a directory with:

```
extension-name/
├── brick.json     # Manifest (MCP server config)
├── index.js       # MCP stdio server
├── package.json   # npm metadata
└── README.md
```

The `brick.json` manifest:
```json
{
  "name": "my-extension",
  "version": "0.1.0",
  "description": "Description",
  "type": "mcp",
  "mcp": {
    "command": "node",
    "args": ["index.js"]
  },
  "capabilities": {
    "tools": ["tool_name"],
    "commands": [],
    "hooks": []
  }
}
```

## Data Flow

```
User types query
  → CLI reads input
  → AgentLoop.run(input)
    → Turn loop (max 20):
      → Prepare messages + tool definitions
      → LLM API call
      → If tool calls → execute each via ToolRegistry
      → Emit progress events
      → Feed results back to LLM
    → Return final response
  → CLI prints response + stats
  → Prompt for next input
```
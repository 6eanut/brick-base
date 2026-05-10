# 🧱 Brick — Modular AI Coding Agent

Snap extensions together like building blocks.

Brick is a modular AI coding agent built on the principle that every
feature should be a pluggable extension. The base provides the core
agent loop, file/shell/git tools, and the MCP-based extension system.
Everything else snaps in as an extension.

## Quick Start

```bash
# Install globally from GitHub
npm install -g github:brick-codeagent/brick-base

# Or clone and install locally
git clone https://github.com/brick-codeagent/brick-base.git
cd brick-base
npm install && npm run build && npm link

# Configuration
export BRICK_API_KEY="your-api-key"
export BRICK_PROVIDER="openai"
export BRICK_MODEL="gpt-4"

# Start coding
brick
```

## CLI Commands

| Command            | Description              |
| ------------------ | ------------------------ |
| `brick`            | Start interactive session |
| `brick --plan`     | Start in plan mode        |
| `brick --model X`  | Specify LLM model         |
| `brick install P`  | Install an extension      |
| `brick init`       | Init in current directory |

## Slash Commands (REPL)

| Command              | Description               |
| -------------------- | ------------------------- |
| `/help`              | Show available commands   |
| `/mode build\|plan`  | Switch agent mode         |
| `/model <name>`      | Change LLM model          |
| `/tools`             | List registered tools     |
| `/extensions`        | List installed extensions |
| `/clear`             | Clear conversation        |
| `/exit`              | Quit                      |

## Architecture

```
User Input → CLI/REPL → Agent Loop → LLM API
                                      ↓
                            Tool Registry
                                      ↓
                    ┌── Built-in (file/shell/git)
                    ├── Extensions (via MCP Bridge)
                    └── Slash Commands
```

## Extensions

Extensions are MCP servers discovered from `~/.brick/extensions/` and
`./extensions/`. Each extension is a process exposing tools via JSON-RPC
over stdio.

```bash
brick install ./extension-web-search
brick install ./extension-repomap
```

## License

MIT
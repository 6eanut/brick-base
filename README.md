# 🧱 Brick — Modular AI Coding Agent

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/brick-codeagent/brick-base/actions/workflows/ci.yml/badge.svg)](https://github.com/brick-codeagent/brick-base/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![GitHub release](https://img.shields.io/github/v/release/brick-codeagent/brick-base)](https://github.com/brick-codeagent/brick-base/releases)

> Snap extensions together like building blocks.

Brick is a modular AI coding agent built on the principle that every
feature should be a pluggable extension. The base provides the core
agent loop, file/shell/git tools, and the MCP-based extension system.
Everything else snaps in as an extension.

## Features

- 🤖 **Multi-turn agent loop** — ReAct pattern (Reasoning + Acting), up to 20 tool rounds
- 🔌 **MCP extension system** — Plug in tools via Model Context Protocol
- 📁 **File operations** — read, write, edit, grep, glob, ls
- 🐚 **Shell execution** — sandboxed commands with timeout
- 🔧 **Git integration** — status, diff, commit, log
- 🎯 **Plan mode** — read-only analysis mode
- ⌨️ **Slash commands** — /help, /mode, /model, /tools, /extensions, /clear
- 👁️ **Progress visualization** — real-time spinner, tool call tracking, timing

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

| Command | Description |
|---------|-------------|
| `brick` | Start interactive session |
| `brick --plan` | Start in plan mode |
| `brick --model X` | Specify LLM model |
| `brick install ./path` | Install an extension from local path |
| `brick init` | Initialize in current directory |
| `brick --help` | Show all options |

## Slash Commands (REPL)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/mode build\|plan` | Switch agent mode |
| `/model <name>` | Change LLM model |
| `/tools` | List registered tools |
| `/extensions` | List installed extensions |
| `/clear` | Clear conversation |
| `/exit` or `/quit` | Quit |

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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture documentation.

## Extensions

Extensions are MCP servers discovered from `~/.brick/extensions/` and
`./extensions/`. Each extension is a process exposing tools via JSON-RPC
over stdio.

```bash
brick install ./extension-web-search
brick install ./extension-repomap
```

See [docs/EXTENSION_DEV.md](docs/EXTENSION_DEV.md) to create your own extensions.

## Configuration

Configuration is resolved in this order: CLI args > environment variables > defaults.

| Env Variable | Description | Default |
|-------------|-------------|---------|
| `BRICK_API_KEY` | LLM API key | — |
| `BRICK_PROVIDER` | LLM provider name | `openai` |
| `BRICK_BASE_URL` | Custom API base URL | `https://api.openai.com/v1` |
| `BRICK_MODEL` | Model name | Provider default |

## Development

```bash
git clone https://github.com/brick-codeagent/brick-base.git
cd brick-base
npm install
npm run build
npm link           # makes `brick` available globally
npm run dev        # watch mode
```

## Contributing

See [CONTRIBUTING.md](https://github.com/brick-codeagent/.github/blob/main/CONTRIBUTING.md).

## License

MIT
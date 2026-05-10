# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] — 2026-05-10

### Added
- Initial release of Brick modular AI coding agent
- Core agent loop with multi-turn LLM interaction (ReAct pattern)
- File tools: read, write, edit, grep, glob, ls
- Shell command execution with timeout and sandbox support
- Git tools: status, diff, commit, log
- MCP-based extension system with automatic discovery
- Extension registry with install/uninstall lifecycle
- Slash command framework (help, mode, model, tools, extensions, exit)
- LLM provider abstraction layer (OpenAI-compatible API)
- Configuration system (CLI args, env vars, config file)
- Conversation management with context window tracking
- Plan mode (read-only analysis mode)
- Progress visualization with spinner, tool call tracking, and timing
- Two reference extensions: web-search and repomap
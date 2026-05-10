/**
 * Brick - A modular coding agent
 *
 * Base entry point. Exports all public APIs for extension consumption.
 */

// Agent
export { AgentLoop } from './agent/loop.js';
export { AgentMode, type AgentConfig } from './agent/loop.js';
export { ConversationManager, type Conversation, type Message, type MessageRole } from './agent/conversation.js';
export { ContextManager, type ContextOptions } from './agent/context.js';

// LLM
export { LLMProvider, type ProviderConfig, type ProviderCapabilities } from './llm/provider.js';
export { ModelRegistry, type ModelInfo } from './llm/models.js';

// Tools
export { ToolRegistry, type Tool, type ToolResult } from './tools/registry.js';
export { FileTool } from './tools/file.js';
export { ShellTool } from './tools/shell.js';
export { GitTool } from './tools/git.js';
export { ToolAnalytics, type ToolStat } from './tools/analytics.js';

// Extensions
export { ExtensionRegistry, type ExtensionManifest, type ExtensionState } from './extensions/registry.js';
export { McpBridge } from './extensions/mcp-bridge.js';

// Config
export { ConfigManager, type BrickConfig } from './config/config.js';

// Commands
export { CommandRegistry, type Command } from './commands/registry.js';
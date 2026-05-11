/**
 * Command registry.
 *
 * Manages slash commands (like `/help`, `/clear`, `/model`) that users
 * can invoke during an interactive session. Commands can be built-in
 * or provided by extensions.
 */

export interface Command {
  /** Command name without the slash (e.g. "help", "clear") */
  name: string;
  /** One-line description */
  description: string;
  /** Usage hint (e.g. "/model <name>") */
  usage?: string;
  /** Execute the command */
  execute(args: string[]): Promise<string>;
}

export interface CommandContext {
  /** Current agent mode */
  mode: string;
  /** Switch agent mode */
  setMode: (mode: string) => void;
  /** Set model */
  setModel: (model: string) => void;
  /** Clear conversation */
  clearConversation: () => void;
  /** List registered tools */
  listTools: () => string;
  /** List installed extensions */
  listExtensions: () => string;
  /** Get tool usage analytics summary */
  getStats?: () => string;
  /** Enable an extension by name */
  enableExtension?: (name: string) => string;
  /** Disable an extension by name */
  disableExtension?: (name: string) => string;
  /** Exit the application */
  exit: () => void;
}

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  register(command: Command): void {
    this.commands.set(command.name, command);
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  unregister(name: string): boolean {
    return this.commands.delete(name);
  }

  listAll(): Command[] {
    return Array.from(this.commands.values());
  }

  /**
   * Try to execute a command from raw input.
   * Returns null if input is not a command.
   */
  async tryExecute(input: string, ctx: CommandContext): Promise<string | null> {
    const trimmed = input.trim();

    // Check if it starts with /
    if (!trimmed.startsWith('/')) {
      return null;
    }

    const parts = trimmed.slice(1).split(/\s+/);
    const cmdName = parts[0];
    const cmdArgs = parts.slice(1);

    const cmd = this.commands.get(cmdName);
    if (!cmd) {
      return `Unknown command: /${cmdName}. Type /help for available commands.`;
    }

    return cmd.execute(cmdArgs);
  }

  /**
   * Register all built-in commands.
   */
  registerBuiltins(ctx: CommandContext): void {
    this.register({
      name: 'help',
      description: 'Show available commands',
      execute: async () => {
        const lines = this.listAll().map(
          cmd => `  /${cmd.name}${cmd.usage ? ' ' + cmd.usage : ''} — ${cmd.description}`,
        );
        return `Available commands:\n${lines.join('\n')}`;
      },
    });

    this.register({
      name: 'clear',
      description: 'Clear conversation history (keep system prompt)',
      execute: async () => {
        ctx.clearConversation();
        return 'Conversation cleared.';
      },
    });

    this.register({
      name: 'mode',
      description: 'Switch agent mode',
      usage: '<build|plan>',
      execute: async (args) => {
        const mode = args[0];
        if (mode !== 'build' && mode !== 'plan') {
          return 'Usage: /mode <build|plan>';
        }
        ctx.setMode(mode);
        return `Switched to ${mode} mode.`;
      },
    });

    this.register({
      name: 'model',
      description: 'Set the LLM model',
      usage: '<model-name>',
      execute: async (args) => {
        if (!args[0]) {
          return 'Usage: /model <model-name>';
        }
        ctx.setModel(args[0]);
        return `Model set to ${args[0]}.`;
      },
    });

    this.register({
      name: 'tools',
      description: 'List all registered tools',
      execute: async () => {
        return ctx.listTools();
      },
    });

    this.register({
      name: 'extensions',
      description: 'List installed extensions',
      execute: async () => {
        return ctx.listExtensions();
      },
    });

    this.register({
      name: 'enable',
      description: 'Enable a disabled extension',
      usage: '<name>',
      execute: async (args) => {
        if (!args[0]) {
          return 'Usage: /enable <extension-name>';
        }
        if (!ctx.enableExtension) {
          return 'Enable/disable not available in this context.';
        }
        return ctx.enableExtension(args[0]);
      },
    });

    this.register({
      name: 'disable',
      description: 'Disable an installed extension',
      usage: '<name>',
      execute: async (args) => {
        if (!args[0]) {
          return 'Usage: /disable <extension-name>';
        }
        if (!ctx.disableExtension) {
          return 'Enable/disable not available in this context.';
        }
        return ctx.disableExtension(args[0]);
      },
    });

    this.register({
      name: 'stats',
      description: 'Show tool usage statistics',
      execute: async () => {
        return ctx.getStats?.() ?? 'Tool analytics not available.';
      },
    });

    this.register({
      name: 'exit',
      description: 'Exit Brick',
      execute: async () => {
        ctx.exit();
        return 'Goodbye!';
      },
    });

    this.register({
      name: 'quit',
      description: 'Exit Brick',
      execute: async () => {
        ctx.exit();
        return 'Goodbye!';
      },
    });
  }
}
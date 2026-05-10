/**
 * Tool registry.
 *
 * Central registry for all tools available to the agent — both built-in and
 * extension-provided. Each tool has a name, description, parameter schema,
 * and an execute function.
 */

export interface Tool {
  /** Unique tool name (e.g. "read_file", "mcp_repomap_map") */
  name: string;
  /** Human-readable description for LLM tool selection */
  description: string;
  /** JSON Schema for tool parameters */
  inputSchema: Record<string, unknown>;
  /** Execute the tool with given arguments */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
  /** Whether this tool is read-only (safe for plan mode) */
  readOnly?: boolean;
}

export interface ToolResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Text output (rendered to LLM) */
  output: string;
  /** Optional error message */
  error?: string;
  /** Optional structured data for programmatic consumers */
  data?: unknown;
}

export interface ToolRegistryOptions {
  /** Maximum bytes allowed in a single tool result output (default: 256KB) */
  maxResultBytes?: number;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private categorized: Map<string, Set<string>> = new Map();
  private maxResultBytes: number;

  constructor(options?: ToolRegistryOptions) {
    this.maxResultBytes = options?.maxResultBytes ?? 262_144; // 256KB default
  }

  /**
   * Register a tool, optionally in a category.
   * Category helps group built-in vs extension tools.
   */
  register(tool: Tool, category: string = 'builtin'): void {
    this.tools.set(tool.name, tool);
    if (!this.categorized.has(category)) {
      this.categorized.set(category, new Set());
    }
    this.categorized.get(category)!.add(tool.name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean {
    const existed = this.tools.has(name);
    this.tools.delete(name);
    // Clean up from categories
    for (const [, names] of this.categorized) {
      names.delete(name);
    }
    return existed;
  }

  listAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions formatted for LLM tool calling API.
   */
  getLLMDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.listAll().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Get only read-only tool definitions (safe for plan mode).
   */
  getReadOnlyDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.listAll()
      .filter(t => t.readOnly)
      .map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
  }

  /**
   * Get tools from a specific category (e.g. "builtin", "extension:repomap").
   */
  getByCategory(category: string): Tool[] {
    const names = this.categorized.get(category);
    if (!names) return [];
    return Array.from(names)
      .map(n => this.tools.get(n))
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * Apply size limit to tool result output.
   * Truncates and appends a truncation notice if output exceeds maxResultBytes.
   */
  private applySizeLimit(result: ToolResult): ToolResult {
    if (result.output.length > this.maxResultBytes) {
      return {
        ...result,
        output: result.output.slice(0, this.maxResultBytes) + `\n... [result truncated to ${this.maxResultBytes} bytes]`,
      };
    }
    return result;
  }

  /**
   * Execute a tool by name with given arguments.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: '',
        error: `Unknown tool: "${name}". Available tools: ${this.listAll().map(t => t.name).join(', ')}`,
      };
    }
    try {
      const result = await tool.execute(args);
      return this.applySizeLimit(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: '',
        error: `Tool "${name}" execution failed: ${message}`,
      };
    }
  }
}
/**
 * Tool usage analytics.
 *
 * Collects per-tool metrics: call count, average duration, error rate.
 * Designed to be wired into the agent event system:
 *
 *   agent.on('tool_result', (data) => analytics.recordCall(data.name, data.durationMs, data.success));
 *
 * Stats can be queried programmatically or via the /stats slash command.
 */

export interface ToolStat {
  /** Total times this tool has been called */
  callCount: number;
  /** Cumulative execution time in milliseconds */
  totalDurationMs: number;
  /** Number of failed executions */
  errorCount: number;
  /** ISO timestamp of the most recent call, or null if never called */
  lastCalled: string | null;
}

export class ToolAnalytics {
  private stats: Map<string, ToolStat> = new Map();

  /**
   * Record a single tool execution.
   *
   * @param name - Tool name (e.g. "read_file", "execute_command")
   * @param durationMs - Execution duration in milliseconds
   * @param success - Whether the tool returned success
   */
  recordCall(name: string, durationMs: number, success: boolean): void {
    const existing = this.stats.get(name);
    const stat: ToolStat = existing ?? {
      callCount: 0,
      totalDurationMs: 0,
      errorCount: 0,
      lastCalled: null,
    };
    stat.callCount += 1;
    stat.totalDurationMs += durationMs;
    if (!success) stat.errorCount += 1;
    stat.lastCalled = new Date().toISOString();
    this.stats.set(name, stat);
  }

  /**
   * Get stats for a specific tool.
   */
  getStats(name: string): ToolStat | undefined {
    return this.stats.get(name);
  }

  /**
   * Get stats for all tools.
   */
  getAllStats(): Map<string, ToolStat> {
    return new Map(this.stats);
  }

  /**
   * Clear all accumulated stats.
   */
  clear(): void {
    this.stats.clear();
  }

  /**
   * Return a formatted summary table suitable for CLI display.
   *
   * Example output:
   *   read_file          │  12  │   1.2s │   0  │  0.0%
   *   execute_command    │   8  │  12.4s │   1  │ 12.5%
   */
  getSummary(): string {
    if (this.stats.size === 0) {
      return 'No tool calls recorded in this session.';
    }

    // Column widths
    const nameWidth = Math.max(
      ...Array.from(this.stats.keys()).map(n => n.length),
      4, // "Tool"
    );

    const header = [
      `${'Tool'.padEnd(nameWidth)} │ Calls │ Avg Dur │ Errors │ Err%`,
      `${''.padEnd(nameWidth, '─')} │ ───── │ ─────── │ ────── │ ────`,
    ];

    const rows = Array.from(this.stats.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, stat]) => {
        const avgMs = stat.callCount > 0 ? stat.totalDurationMs / stat.callCount : 0;
        const avgStr = avgMs >= 1000 ? `${(avgMs / 1000).toFixed(1)}s` : `${Math.round(avgMs)}ms`;
        const errPct = stat.callCount > 0 ? ((stat.errorCount / stat.callCount) * 100).toFixed(1) : '0.0';
        return [
          name.padEnd(nameWidth),
          String(stat.callCount).padStart(5),
          avgStr.padStart(7),
          String(stat.errorCount).padStart(5),
          `${errPct}%`.padStart(4),
        ].join(' │ ');
      });

    return ['Tool Usage Stats', '', ...header, ...rows].join('\n');
  }
}
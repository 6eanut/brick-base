/**
 * ToolAnalytics tests.
 *
 * Covers: recordCall, getStats, getAllStats, clear, getSummary formatting.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolAnalytics } from '../tools/analytics.js';

describe('ToolAnalytics', () => {
  let analytics: ToolAnalytics;

  beforeEach(() => {
    analytics = new ToolAnalytics();
  });

  it('starts with empty stats', () => {
    expect(analytics.getAllStats().size).toBe(0);
    expect(analytics.getSummary()).toContain('No tool calls recorded');
  });

  it('records a successful call', () => {
    analytics.recordCall('read_file', 150, true);
    const stat = analytics.getStats('read_file');
    expect(stat).toBeDefined();
    expect(stat!.callCount).toBe(1);
    expect(stat!.totalDurationMs).toBe(150);
    expect(stat!.errorCount).toBe(0);
    expect(stat!.lastCalled).toBeTruthy();
  });

  it('records a failed call', () => {
    analytics.recordCall('execute_command', 2000, false);
    const stat = analytics.getStats('execute_command');
    expect(stat!.callCount).toBe(1);
    expect(stat!.errorCount).toBe(1);
  });

  it('accumulates multiple calls for same tool', () => {
    analytics.recordCall('read_file', 100, true);
    analytics.recordCall('read_file', 200, true);
    analytics.recordCall('read_file', 50, false);
    const stat = analytics.getStats('read_file');
    expect(stat!.callCount).toBe(3);
    expect(stat!.totalDurationMs).toBe(350);
    expect(stat!.errorCount).toBe(1);
  });

  it('tracks multiple tools independently', () => {
    analytics.recordCall('read_file', 100, true);
    analytics.recordCall('write_file', 50, true);
    analytics.recordCall('execute_command', 500, false);
    expect(analytics.getAllStats().size).toBe(3);
  });

  it('clear resets all stats', () => {
    analytics.recordCall('read_file', 100, true);
    analytics.clear();
    expect(analytics.getAllStats().size).toBe(0);
  });

  it('getSummary formats table correctly', () => {
    analytics.recordCall('read_file', 100, true);
    analytics.recordCall('read_file', 200, true);
    analytics.recordCall('execute_command', 1500, false);
    const summary = analytics.getSummary();
    expect(summary).toContain('Tool Usage Stats');
    expect(summary).toContain('read_file');
    expect(summary).toContain('execute_command');
    // Avg for read_file: (100+200)/2 = 150ms
    expect(summary).toContain('150ms');
    // Error rate: execute_command had 1 error out of 1 call = 100%
    expect(summary).toContain('100.0%');
  });
});
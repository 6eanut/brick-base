/**
 * ProgressRenderer tests.
 *
 * Covers: all event handlers, formatting helpers, spinner lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProgressRenderer } from '../tui/progress.js';

describe('ProgressRenderer', () => {
  let progress: ProgressRenderer;
  let stdoutCalls: string[];
  let consoleLogs: string[];

  beforeEach(() => {
    progress = new ProgressRenderer();
    stdoutCalls = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((str) => {
      stdoutCalls.push(String(str));
      return true;
    });
    consoleLogs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      consoleLogs.push(args.join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    progress.finish();
  });

  it('showThinking writes spinner frame to stdout', () => {
    progress.showThinking({ turn: 1 });
    expect(stdoutCalls.length).toBeGreaterThan(0);
    const output = stdoutCalls.join('');
    expect(output).toContain('LLM is thinking');
    expect(output).toContain('Turn 1');
  });

  it('showToken renders streaming preview on first token', () => {
    progress.showToken({ turn: 1, token: 'Hello', type: 'text' });
    const writes = stdoutCalls.join('');
    expect(writes).toContain('LLM output');
  });

  it('showToken ignores thinking tokens', () => {
    progress.showToken({ turn: 1, token: 'deep thoughts', type: 'thinking' });
    expect(stdoutCalls.length).toBe(0);
  });

  it('showToken updates preview with accumulated content', () => {
    progress.showToken({ turn: 1, token: 'Hello', type: 'text' });
    stdoutCalls.length = 0;
    progress.showToken({ turn: 1, token: ' world', type: 'text' });
    const writes = stdoutCalls.join('');
    expect(writes).toContain('Hello world');
  });

  it('showLLMResponse clears streaming and shows tool count', () => {
    progress.showLLMResponse({ turn: 1, content: '', toolCount: 2 });
    expect(consoleLogs.some(l => l.includes('tool call'))).toBe(true);
  });

  it('showLLMResponse displays reasoning preview when content is long', () => {
    progress.showLLMResponse({ turn: 1, content: 'Let me analyze this code...', toolCount: 1 });
    expect(consoleLogs.some(l => l.includes('Let me analyze'))).toBe(true);
  });

  it('showLLMResponse skips reasoning when content is empty', () => {
    progress.showLLMResponse({ turn: 1, content: undefined, toolCount: 0 });
    expect(consoleLogs.length).toBe(0);
  });

  it('showToolCall prints tool name with args', () => {
    progress.showToolCall({ turn: 1, name: 'read_file', args: { path: '/tmp/test.txt' } });
    expect(consoleLogs.some(l => l.includes('read_file') && l.includes('tmp'))).toBe(true);
  });

  it('showToolCall skips large string args', () => {
    progress.showToolCall({ turn: 1, name: 'write_file', args: { path: '/tmp/x', content: 'x'.repeat(200) } });
    expect(consoleLogs.some(l => l.includes('write_file'))).toBe(true);
    expect(consoleLogs.some(l => l.includes('x'.repeat(200)))).toBe(false);
  });

  it('showToolResult shows success with duration and preview', () => {
    progress.showToolResult({ turn: 1, name: 'read_file', success: true, output: 'file contents', error: undefined, durationMs: 150 });
    expect(consoleLogs.some(l => l.includes('read_file') && l.includes('OK'))).toBe(true);
  });

  it('showToolResult shows failure with error', () => {
    progress.showToolResult({ turn: 1, name: 'read_file', success: false, output: '', error: 'Permission denied', durationMs: 50 });
    expect(consoleLogs.some(l => l.includes('read_file') && l.includes('FAIL'))).toBe(true);
    expect(consoleLogs.some(l => l.includes('Permission denied'))).toBe(true);
  });

  it('showTurnEnd prints turn summary', () => {
    progress.showTurnEnd({ turn: 2, toolCalls: 3 });
    expect(consoleLogs.some(l => l.includes('Turn 2'))).toBe(true);
    expect(consoleLogs.some(l => l.includes('3 tool call'))).toBe(true);
  });

  it('showContextWarning prints warning', () => {
    progress.showContextWarning({ message: 'Context at ~90K/128K tokens' });
    expect(consoleLogs.some(l => l.includes('90K'))).toBe(true);
  });

  it('showError prints error message', () => {
    progress.showError({ message: 'LLM API error (401)' });
    expect(consoleLogs.some(l => l.includes('LLM API error'))).toBe(true);
  });

  it('finish cleans up streaming and spinner state', () => {
    progress.showThinking({ turn: 1 });
    progress.finish();
    expect(stdoutCalls.length).toBeGreaterThan(0);
  });

  it('truncates long output in tool results', () => {
    const long = 'a'.repeat(500);
    progress.showToolResult({ turn: 1, name: 'test', success: true, output: long, error: undefined, durationMs: 10 });
    expect(consoleLogs.some(l => l.includes('aaa'))).toBe(true);
    expect(consoleLogs.some(l => l.includes('a'.repeat(201)))).toBe(false);
  });
});
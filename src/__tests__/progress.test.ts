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
  let consoleCalls: string[];

  beforeEach(() => {
    progress = new ProgressRenderer();
    stdoutCalls = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((str) => {
      stdoutCalls.push(String(str));
      return true;
    });
    consoleCalls = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      consoleCalls.push(args.join(' '));
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
    expect(writes).toContain('Output:');
    expect(writes).toContain('Hello');
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

  it('showLLMResponse shows tool call header via console.log', () => {
    progress.showLLMResponse({ turn: 1, content: '', toolCount: 2 });
    expect(consoleCalls.some(l => l.includes('tool call'))).toBe(true);
  });

  it('showLLMResponse displays reasoning preview when content is long', () => {
    progress.showLLMResponse({ turn: 1, content: 'Let me analyze this code...', toolCount: 1 });
    expect(consoleCalls.some(l => l.includes('Let me analyze'))).toBe(true);
  });

  it('showLLMResponse skips reasoning when content is empty', () => {
    progress.showLLMResponse({ turn: 1, content: undefined, toolCount: 0 });
    expect(consoleCalls.length).toBe(0);
  });

  it('showToolCall prints tool name with args', () => {
    progress.showToolCall({ turn: 1, name: 'read_file', args: { path: '/tmp/test.txt' } });
    const writes = stdoutCalls.join('');
    expect(writes).toContain('read_file');
    expect(writes).toContain('tmp');
  });

  it('showToolCall skips large string args', () => {
    progress.showToolCall({ turn: 1, name: 'write_file', args: { path: '/tmp/x', content: 'x'.repeat(200) } });
    const writes = stdoutCalls.join('');
    expect(writes).toContain('write_file');
    expect(writes).not.toContain('x'.repeat(200));
  });

  it('showToolResult shows success with duration and preview', () => {
    // Must call showToolCall first to register the tool in the group
    progress.showToolCall({ turn: 1, name: 'read_file', args: { path: '/tmp/test.txt' } });
    stdoutCalls.length = 0;
    progress.showToolResult({ turn: 1, name: 'read_file', success: true, output: 'file contents', error: undefined, durationMs: 150 });
    const writes = stdoutCalls.join('');
    expect(writes).toContain('read_file');
    expect(writes).toContain('OK');
  });

  it('showToolResult shows failure with error', () => {
    progress.showToolCall({ turn: 1, name: 'read_file', args: { path: '/tmp/test.txt' } });
    stdoutCalls.length = 0;
    progress.showToolResult({ turn: 1, name: 'read_file', success: false, output: '', error: 'Permission denied', durationMs: 50 });
    const writes = stdoutCalls.join('');
    expect(writes).toContain('read_file');
    expect(writes).toContain('FAIL');
    expect(writes).toContain('Permission denied');
  });

  it('showTurnEnd prints turn summary', () => {
    progress.showTurnEnd({ turn: 2, toolCalls: 3 });
    expect(consoleCalls.some(l => l.includes('Turn 2'))).toBe(true);
    expect(consoleCalls.some(l => l.includes('3 tool call'))).toBe(true);
  });

  it('showContextWarning prints warning', () => {
    progress.showContextWarning({ message: 'Context at ~90K/128K tokens' });
    expect(consoleCalls.some(l => l.includes('90K'))).toBe(true);
  });

  it('showError prints error message', () => {
    progress.showError({ message: 'LLM API error (401)' });
    expect(consoleCalls.some(l => l.includes('LLM API error'))).toBe(true);
  });

  it('finish cleans up streaming and spinner state', () => {
    progress.showThinking({ turn: 1 });
    progress.finish();
    expect(stdoutCalls.length).toBeGreaterThan(0);
  });

  it('truncates long output in tool results', () => {
    const long = 'a'.repeat(500);
    progress.showToolCall({ turn: 1, name: 'test', args: {} });
    stdoutCalls.length = 0;
    progress.showToolResult({ turn: 1, name: 'test', success: true, output: long, error: undefined, durationMs: 10 });
    const writes = stdoutCalls.join('');
    expect(writes).toContain('aaa');
    expect(writes).not.toContain('a'.repeat(201));
  });
});
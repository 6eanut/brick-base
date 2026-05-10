import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationManager } from '../agent/conversation.js';

describe('ConversationManager', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager();
  });

  it('should add user messages', () => {
    manager.addUserMessage('Hello');
    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello');
  });

  it('should add assistant messages', () => {
    manager.addAssistantMessage('Hi there!');
    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Hi there!');
  });

  it('should add tool messages', () => {
    manager.addToolMessage('call-123', 'get_weather', 'Sunny, 72°F');
    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('tool');
    expect(messages[0].toolCallId).toBe('call-123');
    expect(messages[0].toolName).toBe('get_weather');
    expect(messages[0].content).toBe('Sunny, 72°F');
  });

  it('should get messages in order', () => {
    manager.addUserMessage('First');
    manager.addAssistantMessage('Second');
    manager.addUserMessage('Third');

    const messages = manager.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('First');
    expect(messages[1].content).toBe('Second');
    expect(messages[2].content).toBe('Third');
  });

  it('should clear conversation', () => {
    manager.addUserMessage('Hello');
    manager.addAssistantMessage('Hi');
    expect(manager.getMessages()).toHaveLength(2);

    manager.clear();
    expect(manager.getMessages()).toHaveLength(0);
  });

  it('should clear conversation but keep system prompt', () => {
    manager.setSystemPrompt('You are a helpful assistant.');
    manager.addUserMessage('Hello');
    manager.addAssistantMessage('Hi');
    expect(manager.getMessages()).toHaveLength(3);

    manager.clear();
    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
  });

  it('should set system prompt', () => {
    manager.setSystemPrompt('You are a helpful assistant.');
    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
  });

  it('should replace existing system prompt on subsequent calls', () => {
    manager.setSystemPrompt('First prompt.');
    manager.setSystemPrompt('Second prompt.');
    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Second prompt.');
  });
});
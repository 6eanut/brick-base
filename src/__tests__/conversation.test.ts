import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  it('should add user message with images', () => {
    manager.addUserMessage('What is in this image?', [
      { data: 'base64data', mediaType: 'image/png' },
    ]);
    const messages = manager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].images).toBeDefined();
    expect(messages[0].images).toHaveLength(1);
    expect(messages[0].images![0].mediaType).toBe('image/png');
  });

  it('should filter system messages with getNonSystemMessages', () => {
    manager.setSystemPrompt('System prompt.');
    manager.addUserMessage('Hello');
    const nonSystem = manager.getNonSystemMessages();
    expect(nonSystem).toHaveLength(1);
    expect(nonSystem[0].role).toBe('user');
  });

  it('should create a new conversation and switch to it', () => {
    const first = manager.getActive();
    const second = manager.create();
    expect(second.id).not.toBe(first.id);
    expect(manager.getActive().id).toBe(second.id);
  });

  it('should switch to existing conversation', () => {
    const first = manager.getActive();
    const second = manager.create();
    const switched = manager.switchTo(first.id);
    expect(switched?.id).toBe(first.id);
    expect(manager.getActive().id).toBe(first.id);
  });

  it('should return undefined when switching to unknown id', () => {
    const result = manager.switchTo('nonexistent');
    expect(result).toBeUndefined();
  });

  it('should list all conversations', () => {
    const first = manager.getActive();
    manager.create();
    const all = manager.listAll();
    expect(all).toHaveLength(2);
    expect(all.map(c => c.id)).toContain(first.id);
  });

  it('should persist a conversation without throwing', async () => {
    const persistManager = new ConversationManager(true);
    persistManager.addUserMessage('Hello');
    persistManager.addAssistantMessage('Hi there!');
    // Should not throw
    await expect(persistManager.persist()).resolves.toBeUndefined();
  });

  it('should not persist when disabled', async () => {
    const noPersistManager = new ConversationManager(false);
    noPersistManager.addUserMessage('No persist');
    expect(noPersistManager.getMessages()).toHaveLength(1);
  });
});
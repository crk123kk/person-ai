import { describe, it, expect } from 'vitest';
import { QueryCache, ContextManager, estimateTokens } from '../../utils/cache.js';

describe('QueryCache', () => {
  it('应该缓存和检索查询结果', () => {
    const cache = new QueryCache({ ttl: 60000, maxSize: 100 });
    const mockDocs = [
      { pageContent: 'Content 1', metadata: {} },
      { pageContent: 'Content 2', metadata: {} },
    ];

    cache.set('test query', mockDocs as any);
    const result = cache.get('test query');

    expect(result).toEqual(mockDocs);
  });

  it('相同查询应该返回相同结果', () => {
    const cache = new QueryCache({ ttl: 60000, maxSize: 100 });
    const mockDocs = [{ pageContent: 'Test', metadata: {} }];

    cache.set('query 1', mockDocs as any);
    cache.set('query 1', mockDocs as any);

    expect(cache.getStats().size).toBe(1);
  });

  it('应该清除所有缓存', () => {
    const cache = new QueryCache({ ttl: 60000, maxSize: 100 });

    cache.set('query 1', [] as any);
    cache.set('query 2', [] as any);
    cache.clear();

    expect(cache.getStats().size).toBe(0);
  });
});

describe('ContextManager', () => {
  it('应该估算 token 数量', () => {
    const english = estimateTokens('Hello world');
    const chinese = estimateTokens('你好世界');

    expect(english).toBeGreaterThan(0);
    expect(chinese).toBeGreaterThan(0);
  });

  it('当上下文未超限时应该返回原消息', async () => {
    const manager = new ContextManager({
      maxTokens: 4096,
      reservedForPrompt: 500,
      strategy: 'sliding',
    });

    const messages = [
      { role: 'user' as const, content: 'Hello', timestamp: new Date().toISOString() },
      { role: 'assistant' as const, content: 'Hi there', timestamp: new Date().toISOString() },
    ];

    const result = await manager.manageContext(messages);
    expect(result).toEqual(messages);
  });

  it('当上下文超限时应该使用滑动窗口', async () => {
    const manager = new ContextManager({
      maxTokens: 100, // 很小的值以触发滑动
      reservedForPrompt: 10,
      strategy: 'sliding',
    });

    const messages = Array(20).fill(null).map((_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Message ${i} with some content to make it longer`,
      timestamp: new Date().toISOString(),
    }));

    const result = await manager.manageContext(messages);
    expect(result.length).toBeLessThan(messages.length);
  });
});

describe('estimateTokens', () => {
  it('空字符串应该返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('英文文本估算', () => {
    const result = estimateTokens('Hello world, this is a test');
    expect(result).toBeGreaterThan(0);
  });

  it('中文文本估算', () => {
    const result = estimateTokens('你好世界，这是一个测试');
    expect(result).toBeGreaterThan(0);
  });

  it('混合文本估算', () => {
    const english = estimateTokens('Hello 世界');
    const chinese = estimateTokens('你好 World');

    // 混合文本应该有合理的估算
    expect(english).toBeGreaterThan(0);
    expect(chinese).toBeGreaterThan(0);
  });
});

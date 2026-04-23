import { Document } from '@langchain/core/documents';
import logger from '../utils/logger.js';

/**
 * 缓存条目
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Query 缓存配置
 */
export interface QueryCacheConfig {
  ttl: number;        // 过期时间 (ms)
  maxSize: number;    // 最大缓存条目
}

const DEFAULT_CONFIG: QueryCacheConfig = {
  ttl: 3600000, // 1 小时
  maxSize: 1000,
};

/**
 * Query 缓存
 * 缓存检索结果，避免重复查询
 */
export class QueryCache {
  private cache: Map<string, CacheEntry<Document[]>>;
  private config: QueryCacheConfig;

  constructor(config?: Partial<QueryCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
  }

  /**
   * 获取缓存
   */
  get(query: string): Document[] | null {
    const key = this.hashQuery(query);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    if (Date.now() - entry.timestamp > this.config.ttl) {
      logger.debug(`Cache miss (expired): ${query}`);
      this.cache.delete(key);
      return null;
    }

    logger.debug(`Cache hit: ${query}`);
    return entry.data;
  }

  /**
   * 设置缓存
   */
  set(query: string, results: Document[]): void {
    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.config.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    const key = this.hashQuery(query);
    this.cache.set(key, {
      data: results,
      timestamp: Date.now(),
    });

    logger.debug(`Cache set: ${query}`);
  }

  /**
   * 清除缓存
   */
  clear(): void {
    this.cache.clear();
    logger.info('Query cache cleared');
  }

  /**
   * 获取统计信息
   */
  getStats(): { size: number; ttl: number } {
    return {
      size: this.cache.size,
      ttl: this.config.ttl,
    };
  }

  /**
   * 清理过期条目
   */
  cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.config.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired cache entries`);
    }
  }

  /**
   * 哈希查询（简单哈希）
   */
  private hashQuery(query: string): string {
    // 归一化查询
    const normalized = query
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');

    // 简单哈希
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    return `query_${hash}`;
  }
}

/**
 * 上下文管理器
 * 管理对话上下文窗口
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  sources?: string[];
}

export interface ContextManagerConfig {
  maxTokens: number;
  reservedForPrompt: number;
  compressionThreshold: number;
  strategy: 'sliding' | 'summary' | 'map-reduce';
}

const DEFAULT_CONTEXT_CONFIG: ContextManagerConfig = {
  maxTokens: 4096,
  reservedForPrompt: 500,
  compressionThreshold: 0.8,
  strategy: 'sliding',
};

/**
 * 简单的 token 计数器（估算）
 */
export function estimateTokens(text: string): number {
  // 简单估算：英文 ~4 字符/token，中文 ~2 字符/token
  const english = text.replace(/[一-龥]/g, '').length;
  const chinese = (text.match(/[一-龥]/g) || []).length;
  return Math.ceil(english / 4 + chinese / 2);
}

/**
 * 上下文管理器
 */
export class ContextManager {
  private config: ContextManagerConfig;

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  }

  /**
   * 管理上下文，返回适合发送给 LLM 的消息列表
   */
  async manageContext(messages: Message[]): Promise<Message[]> {
    const currentTokens = this.countMessagesTokens(messages);
    const maxAllowed = this.config.maxTokens - this.config.reservedForPrompt;

    if (currentTokens <= maxAllowed) {
      return messages; // 无需处理
    }

    logger.info(
      `Context overflow: ${currentTokens} > ${maxAllowed} tokens, applying strategy`
    );

    switch (this.config.strategy) {
      case 'sliding':
        return this.slidingWindow(messages);

      case 'summary':
        return this.summaryStrategy(messages);

      case 'map-reduce':
        return this.mapReduce(messages);

      default:
        return this.slidingWindow(messages);
    }
  }

  /**
   * 滑动窗口：保留最近 N 轮
   */
  private slidingWindow(messages: Message[]): Message[] {
    // 保留最近 6 条消息（3 轮对话）
    const recentMessages = messages.slice(-6);

    // 如果还是超出，继续缩减
    while (
      this.countMessagesTokens(recentMessages) >
        this.config.maxTokens - this.config.reservedForPrompt &&
      recentMessages.length > 2
    ) {
      recentMessages.shift();
    }

    return recentMessages;
  }

  /**
   * 摘要策略：总结早期对话
   */
  private async summaryStrategy(messages: Message[]): Promise<Message[]> {
    const earlyMessages = messages.slice(0, -6);
    const recentMessages = messages.slice(-6);

    if (earlyMessages.length === 0) {
      return recentMessages;
    }

    // 生成早期对话摘要
    const earlyContent = earlyMessages.map(m => `${m.role}: ${m.content}`).join('\n');
    const summary = `Previous conversation summary: ${earlyContent.slice(0, 500)}...`;

    return [
      { role: 'system', content: summary, timestamp: new Date().toISOString() },
      ...recentMessages,
    ];
  }

  /**
   * Map-Reduce 策略
   */
  private async mapReduce(messages: Message[]): Promise<Message[]> {
    // 简化实现：分批处理再合并
    const batchSize = 4;
    const batches: Message[][] = [];

    for (let i = 0; i < messages.length; i += batchSize) {
      batches.push(messages.slice(i, i + batchSize));
    }

    // 保留最后一批和倒数第二批
    const result = batches.slice(-2).flat();
    return result;
  }

  /**
   * 计算消息 token 数
   */
  private countMessagesTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }
}

export default QueryCache;

import { Embeddings } from '@langchain/core/embeddings';
import { OpenAIEmbeddings } from '@langchain/openai';
import { OllamaEmbeddings } from '@langchain/ollama';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Embedding 服务
 * 负责文本向量化
 */
export class EmbeddingService {
  private embeddings: Embeddings;
  private provider: string;

  constructor() {
    this.provider = config.embeddingProvider;
    this.embeddings = this.initializeEmbeddings();
    logger.info(`Embedding service initialized with provider: ${this.provider}`);
  }

  private initializeEmbeddings(): Embeddings {
    switch (this.provider) {
      case 'ollama':
        return new OllamaEmbeddings({
          baseUrl: config.ollamaBaseUrl,
          model: config.ollamaEmbedModel || 'mxbai-embed-large',
        });

      case 'openai':
        return new OpenAIEmbeddings({
          apiKey: config.embeddingApiKey,
          model: 'text-embedding-3-small',
        });

      default:
        throw new Error(`Unknown embedding provider: ${this.provider}`);
    }
  }

  /**
   * 获取底层 Embeddings 实例
   */
  getInstance(): Embeddings {
    return this.embeddings;
  }

  /**
   * 批量生成向量（带重试和进度）
   */
  async embedDocuments(texts: string[], onProgress?: (progress: number) => void): Promise<number[][]> {
    const batchSize = config.embeddingBatchSize;
    const maxRetries = config.embeddingMaxRetries;
    const vectors: number[][] = [];

    logger.info(`Embedding ${texts.length} documents in batches of ${batchSize}`);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      let success = false;
      let attempts = 0;

      while (!success && attempts < maxRetries) {
        try {
          const batchVectors = await this.embeddings.embedDocuments(batch);
          vectors.push(...batchVectors);
          success = true;

          // 进度日志
          const progress = Math.min(i + batchSize, texts.length);
          const percent = Math.round((progress / texts.length) * 100);
          logger.info(`Embedding progress: ${progress}/${texts.length} (${percent}%)`);

          // 回调进度
          if (onProgress) {
            onProgress(percent);
          }
        } catch (error) {
          attempts++;
          logger.warn(`Embedding batch failed (attempt ${attempts}/${maxRetries}):`, error);

          if (attempts >= maxRetries) {
            logger.error(`Embedding batch failed after ${maxRetries} attempts`);
            throw error;
          }

          // 指数退避
          const delay = Math.pow(2, attempts) * 1000;
          await this.sleep(delay);
        }
      }
    }

    return vectors;
  }

  /**
   * 单个文本向量化
   */
  async embedQuery(text: string): Promise<number[]> {
    try {
      return await this.embeddings.embedQuery(text);
    } catch (error) {
      logger.error('Embed query failed:', error);
      throw error;
    }
  }

  /**
   * 获取向量维度
   */
  async getDimension(): Promise<number> {
    // 通过嵌入一个测试文本获取维度
    const testVector = await this.embedQuery('test');
    return testVector.length;
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.embedQuery('health check');
      return true;
    } catch (error) {
      logger.error('Embedding health check failed:', error);
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default EmbeddingService;

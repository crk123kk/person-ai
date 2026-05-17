import { Embeddings } from '@langchain/core/embeddings';
import { OpenAIEmbeddings } from '@langchain/openai';
import { OllamaEmbeddings } from '@langchain/ollama';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';

/**
 * Embedding 服务（全局单例）
 * 负责文本向量化，所有 RAGService 共享同一实例
 */
export class EmbeddingService {
  private embeddings: Embeddings;
  private provider: string;
  private static instance: EmbeddingService | null = null;
  private ollamaPinned = false;

  /** Ollama 单条文本最大字符数（超过截断，避免 NaN） */
  private static readonly OLLAMA_MAX_CHARS = 2000;
  /** 逐条嵌入时 Ollama API 超时（ms） */
  private static readonly OLLAMA_SINGLE_TIMEOUT = 60000;
  /** 截断重试的最大次数 */
  private static readonly TRUNCATE_RETRIES = 3;

  private constructor() {
    this.provider = config.embeddingProvider;
    this.embeddings = this.initializeEmbeddings();
    logger.info(`Embedding service initialized with provider: ${this.provider}`);
  }

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
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

  getEmbeddings(): Embeddings {
    return this.embeddings;
  }

  /**
   * 锁住 Ollama 模型不被自动卸载（keep_alive=-1 = 永久保持）
   */
  private async ollamaPinModel(): Promise<void> {
    if (this.ollamaPinned) return;
    const model = config.ollamaEmbedModel || 'mxbai-embed-large';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      await fetch(`${config.ollamaBaseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: ['ping'], keep_alive: -1 }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      this.ollamaPinned = true;
      logger.info(`Ollama model "${model}" pinned (keep_alive=-1)`);
    } catch (error) {
      logger.warn('Failed to pin Ollama model:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 直接调用 Ollama /api/embed 嵌入单条文本
   * 返回向量，如果失败则抛出异常
   */
  private async ollamaEmbedSingle(text: string): Promise<number[]> {
    const model = config.ollamaEmbedModel || 'mxbai-embed-large';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EmbeddingService.OLLAMA_SINGLE_TIMEOUT);

    try {
      const resp = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: [text],
          keep_alive: -1,
          truncate: true,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Ollama API ${resp.status}: ${body.slice(0, 200)}`);
      }

      const data = await resp.json() as { embeddings: number[][] };

      if (!data.embeddings || !Array.isArray(data.embeddings) || data.embeddings.length === 0) {
        throw new Error('Ollama returned empty embeddings');
      }

      const vector = data.embeddings[0];

      // 检查 NaN/Inf
      if (vector.some(val => !Number.isFinite(val))) {
        throw new Error('NaN_OR_INF');
      }

      return vector;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }

  /**
   * 嵌入单条文本，带截断重试
   * 如果 Ollama 返回 NaN，逐步截断文本再重试
   */
  private async ollamaEmbedWithTruncateRetry(text: string): Promise<number[]> {
    let currentText = text;

    for (let attempt = 0; attempt <= EmbeddingService.TRUNCATE_RETRIES; attempt++) {
      try {
        return await this.ollamaEmbedSingle(currentText);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        if (errMsg.includes('NaN_OR_INF')) {
          // NaN → 截断文本到一半长度重试
          const halfLen = Math.floor(currentText.length / 2);
          if (halfLen < 10) {
            logger.warn(`Text still produces NaN after max truncation, using zeros (original len: ${text.length})`);
            return [];
          }
          currentText = currentText.slice(0, halfLen);
          logger.warn(`NaN detected, truncating to ${halfLen} chars (attempt ${attempt + 1})`);
        } else {
          // 其他错误（超时、网络等）→ 不重试截断，直接抛出
          throw error;
        }
      }
    }

    logger.warn(`All truncate retries exhausted for text (len: ${text.length}), using zeros`);
    return [];
  }

  /**
   * 批量生成向量
   *
   * Ollama 策略（重写）：
   * 1. 开始前 pin 住模型（keep_alive=-1）
   * 2. 逐条调用 /api/embed，truncate=true 让 Ollama 自动截断
   * 3. NaN 检测：如果返回 NaN → 截断文本到一半 → 重试
   * 4. 不再每 60 条强制卸载重载（之前这是不必要的开销）
   */
  async embedDocuments(texts: string[], onProgress?: (progress: number) => void): Promise<number[][]> {
    const isOllama = this.provider === 'ollama';

    const safeTexts = texts.map(t => {
      if (!t || !t.trim()) return ' ';
      if (isOllama && t.length > EmbeddingService.OLLAMA_MAX_CHARS) {
        return t.slice(0, EmbeddingService.OLLAMA_MAX_CHARS);
      }
      return t;
    });

    // OpenAI 走原有的 LangChain 批量接口
    if (!isOllama) {
      const vectors = await this.embeddings.embedDocuments(safeTexts);
      if (onProgress) onProgress(100);
      return vectors;
    }

    // Ollama: pin 模型
    await this.ollamaPinModel();

    const vectors: number[][] = [];
    let vectorDim = -1;

    logger.info(`Embedding ${safeTexts.length} texts one-by-one via Ollama /api/embed`);

    for (let i = 0; i < safeTexts.length; i++) {
      try {
        const vector = await this.ollamaEmbedWithTruncateRetry(safeTexts[i]);

        if (vector.length === 0) {
          // 所有重试都失败了，用零向量
          const dim = vectorDim > 0 ? vectorDim : 1024;
          vectors.push(new Array(dim).fill(0));
        } else {
          if (vectorDim < 0) vectorDim = vector.length;
          vectors.push(vector);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`Embed failed for text ${i} (${safeTexts[i].slice(0, 50)}...): ${errMsg}`);
        const dim = vectorDim > 0 ? vectorDim : 1024;
        vectors.push(new Array(dim).fill(0));
      }

      // 进度报告
      const percent = Math.round(((i + 1) / safeTexts.length) * 100);
      if (onProgress) onProgress(percent);

      if ((i + 1) % 50 === 0 || i === safeTexts.length - 1) {
        logger.info(`Embedding progress: ${i + 1}/${safeTexts.length} (${percent}%)`);
      }

      // 批次间短延迟，给 GPU 留喘息空间
      if (i + 1 < safeTexts.length) {
        await this.sleep(100);
      }
    }

    return vectors;
  }

  /**
   * 单个文本向量化
   */
  async embedQuery(text: string): Promise<number[]> {
    const isOllama = this.provider === 'ollama';
    const safeText = (text && text.trim()) ? text : ' ';
    const truncatedText = (isOllama && safeText.length > EmbeddingService.OLLAMA_MAX_CHARS)
      ? safeText.slice(0, EmbeddingService.OLLAMA_MAX_CHARS)
      : safeText;

    if (isOllama) {
      try {
        const vector = await this.ollamaEmbedWithTruncateRetry(truncatedText);
        if (vector.length === 0) {
          return new Array(1024).fill(0);
        }
        return vector;
      } catch (error) {
        logger.error('Embed query failed:', error);
        throw error;
      }
    }

    try {
      const vector = await this.embeddings.embedQuery(truncatedText);
      if (vector.some(val => !Number.isFinite(val))) {
        logger.warn('NaN/Inf in embedQuery result, replacing with zeros');
        return vector.map(() => 0);
      }
      return vector;
    } catch (error) {
      logger.error('Embed query failed:', error);
      throw error;
    }
  }

  async getDimension(): Promise<number> {
    const testVector = await this.embedQuery('test');
    return testVector.length;
  }

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

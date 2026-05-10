import { Document } from '@langchain/core/documents';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import type { Embeddings } from '@langchain/core/embeddings';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';
import path from 'path';
import fs from 'fs';

export interface VectorMetadata {
  source: string;
  displayName?: string;
  chunkIndex: number;
  totalChunks: number;
  fileType: string;
  uploadTime: string;
  customTags?: string[];
}

interface StoredDocument {
  pageContent: string;
  metadata: Record<string, any>;
}

/**
 * 向量存储服务
 * 使用 MemoryVectorStore + 本地持久化
 */
export class VectorStoreService {
  private vectorStore: MemoryVectorStore | null = null;
  private embeddings: Embeddings;
  private persistPath: string;
  private cachedDocs: Map<string, StoredDocument> = new Map();
  private isDirty = false;

  constructor(embeddings: Embeddings) {
    this.embeddings = embeddings;
    this.persistPath = path.resolve(config.vectorstoreDir, 'memory-store.json');
  }

  /**
   * 初始化向量库（从持久化加载）
   */
  private async ensureInitialized(): Promise<MemoryVectorStore> {
    if (!this.vectorStore) {
      logger.info('Initializing MemoryVectorStore...');

      try {
        // 尝试从持久化文件加载
        if (fs.existsSync(this.persistPath)) {
          logger.info('Loading vectors from persistent storage...');
          const data = fs.readFileSync(this.persistPath, 'utf-8');
          const stored = JSON.parse(data);

          this.vectorStore = new MemoryVectorStore(this.embeddings);
          this.cachedDocs = new Map();

          // 恢复文档
          if (stored.documents && stored.documents.length > 0) {
            const docs = stored.documents.map((doc: StoredDocument) =>
              new Document({
                pageContent: doc.pageContent,
                metadata: doc.metadata,
              })
            );
            await this.vectorStore.addDocuments(docs);
            docs.forEach((doc: Document, idx: number) => {
              this.cachedDocs.set(`${doc.metadata.source}_${idx}`, {
                pageContent: doc.pageContent,
                metadata: doc.metadata,
              });
            });
            logger.info(`Loaded ${stored.documents.length} vectors from storage`);
          }
        } else {
          this.vectorStore = new MemoryVectorStore(this.embeddings);
          this.cachedDocs = new Map();
          logger.info('Created new MemoryVectorStore');
        }
      } catch (error) {
        logger.error('Failed to initialize vector store:', error);
        this.vectorStore = new MemoryVectorStore(this.embeddings);
        this.cachedDocs = new Map();
      }
    }

    return this.vectorStore;
  }

  /**
   * 持久化到磁盘
   */
  private async persist(): Promise<void> {
    if (!this.isDirty) return;

    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        documents: Array.from(this.cachedDocs.values()),
        timestamp: new Date().toISOString(),
      };

      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
      this.isDirty = false;
      logger.info(`Persisted ${data.documents.length} vectors to disk`);
    } catch (error) {
      logger.error('Failed to persist vector store:', error);
    }
  }

  /**
   * 添加带元数据的文档
   */
  async addDocuments(
    documents: Document[],
    options: { ids?: string[] }
  ): Promise<string[]> {
    const store = await this.ensureInitialized();
    const ids = options.ids || [];

    logger.info(`Adding ${documents.length} documents to vector store`);

    try {
      await store.addDocuments(documents);

      // 更新缓存
      documents.forEach((doc, i) => {
        const id = ids[i] || `doc_${Date.now()}_${i}`;
        this.cachedDocs.set(id, {
          pageContent: doc.pageContent,
          metadata: doc.metadata,
        });
      });

      this.isDirty = true;
      await this.persist();

      logger.info(`Successfully added ${documents.length} documents to vector store`);
      return ids.length ? ids : documents.map((_, i) => `doc_${Date.now()}_${i}`);
    } catch (error) {
      logger.error('Failed to add documents:', error);
      throw error;
    }
  }

  /**
   * 相似度搜索
   */
  async similaritySearch(
    query: string,
    k: number = 5,
    filter?: Partial<VectorMetadata>
  ): Promise<Document[]> {
    const store = await this.ensureInitialized();

    try {
      const results = await store.similaritySearch(query, k);

      // 应用过滤器
      if (filter) {
        return results.filter(doc => {
          for (const [key, value] of Object.entries(filter)) {
            if (doc.metadata[key] !== value) {
              return false;
            }
          }
          return true;
        });
      }

      return results;
    } catch (error) {
      logger.error('Similarity search failed:', error);
      return [];
    }
  }

  /**
   * 相似度搜索带分数
   */
  async similaritySearchWithScore(
    query: string,
    k: number = 5,
    filter?: Partial<VectorMetadata>
  ): Promise<[Document, number][]> {
    const store = await this.ensureInitialized();

    try {
      const results = await store.similaritySearchVectorWithScore(
        await this.embeddings.embedQuery(query),
        k
      );

      // 应用过滤器
      if (filter) {
        return results.filter(([doc]) => {
          for (const [key, value] of Object.entries(filter)) {
            if (doc.metadata[key] !== value) {
              return false;
            }
          }
          return true;
        });
      }

      return results;
    } catch (error) {
      logger.error('Similarity search with score failed:', error);
      return [];
    }
  }

  /**
   * 删除文档（按源文件）
   */
  async deleteBySource(source: string): Promise<void> {
    await this.ensureInitialized();

    logger.info(`Deleting documents for source: ${source}`);

    try {
      const idsToDelete: string[] = [];

      for (const [id, doc] of this.cachedDocs.entries()) {
        if (doc.metadata.source === source) {
          idsToDelete.push(id);
        }
      }

      if (idsToDelete.length > 0) {
        idsToDelete.forEach(id => this.cachedDocs.delete(id));

        // 重建向量存储
        this.vectorStore = new MemoryVectorStore(this.embeddings);
        if (this.cachedDocs.size > 0) {
          const remainingDocs = Array.from(this.cachedDocs.values()).map(
            d => new Document({ pageContent: d.pageContent, metadata: d.metadata })
          );
          await this.vectorStore.addDocuments(remainingDocs);
        }

        this.isDirty = true;
        await this.persist();

        logger.info(`Deleted ${idsToDelete.length} vectors for source: ${source}`);
      }
    } catch (error) {
      logger.error('Failed to delete documents:', error);
      throw error;
    }
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<{ totalChunks: number; totalFiles: number }> {
    await this.ensureInitialized();

    const totalChunks = this.cachedDocs.size;
    const uniqueFiles = new Set(
      Array.from(this.cachedDocs.values()).map(doc => doc.metadata.source)
    ).size;

    return { totalChunks, totalFiles: uniqueFiles };
  }

  /**
   * 关键词搜索（中文分词简化版：按 2-4 字的滑动窗口匹配）
   */
  keywordSearch(query: string, topK: number = 5): { doc: StoredDocument; score: number }[] {
    const results: { doc: StoredDocument; score: number }[] = [];
    // 从查询中提取 2-4 字的子串作为关键词
    const keywords: string[] = [];
    const cleanQuery = query.replace(/[\s，。？！、；：''（）\[\]{}]/g, '');
    for (let len = Math.min(4, cleanQuery.length); len >= 2; len--) {
      for (let i = 0; i <= cleanQuery.length - len; i++) {
        const kw = cleanQuery.substring(i, i + len);
        if (!keywords.includes(kw)) keywords.push(kw);
      }
    }

    for (const doc of this.cachedDocs.values()) {
      let matchCount = 0;
      for (const kw of keywords) {
        if (doc.pageContent.includes(kw)) matchCount++;
      }
      if (matchCount > 0) {
        results.push({ doc, score: matchCount / keywords.length });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 获取所有源文件列表
   */
  async listSources(): Promise<string[]> {
    await this.ensureInitialized();

    const sources = new Set(
      Array.from(this.cachedDocs.values()).map(doc => doc.metadata.source)
    );
    return Array.from(sources).filter(Boolean) as string[];
  }

  /**
   * 清空向量库
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();

    try {
      this.vectorStore = new MemoryVectorStore(this.embeddings);
      this.cachedDocs = new Map();
      this.isDirty = true;

      if (fs.existsSync(this.persistPath)) {
        fs.unlinkSync(this.persistPath);
      }

      await this.persist();
      logger.info('Cleared all vectors from store');
    } catch (error) {
      logger.error('Failed to clear vector store:', error);
      throw error;
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.getStats();
      return true;
    } catch (error) {
      logger.error('Vector store health check failed:', error);
      return false;
    }
  }

  /**
   * 清理 ID 中的特殊字符
   */
  static sanitizeId(id: string): string {
    return id
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/\/+/g, '_')
      .replace(/\\+/g, '_');
  }
}

export default VectorStoreService;

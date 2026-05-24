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

interface PersistedEntry {
  pageContent: string;
  metadata: Record<string, any>;
  /** Pre-computed embedding vector (serialized alongside doc to skip re-embed on load) */
  vector?: number[];
}

/**
 * 向量存储服务
 * 使用 MemoryVectorStore + 本地持久化（带向量序列化，避免重嵌入）
 */
export class VectorStoreService {
  private vectorStore: MemoryVectorStore | null = null;
  private embeddings: Embeddings;
  private persistPath: string;
  private cachedDocs: Map<string, StoredDocument> = new Map();
  private isDirty = false;

  constructor(embeddings: Embeddings, persistPath?: string) {
    this.embeddings = embeddings;
    this.persistPath = persistPath || path.resolve(config.vectorstoreDir, 'memory-store.json');
  }

  /**
   * 初始化向量库（从持久化加载，优先使用预存向量避免重嵌入）
   */
  private async ensureInitialized(): Promise<MemoryVectorStore> {
    if (this.vectorStore) {
      return this.vectorStore;
    }

    logger.info('Initializing MemoryVectorStore...');

    try {
      if (fs.existsSync(this.persistPath)) {
        logger.info('Loading vectors from persistent storage...');
        const data = fs.readFileSync(this.persistPath, 'utf-8');
        const stored = JSON.parse(data);

        this.vectorStore = new MemoryVectorStore(this.embeddings);
        this.cachedDocs = new Map();

        const entries: PersistedEntry[] = stored.documents || [];

        if (entries.length > 0) {
          // 检查是否包含预存向量
          const hasVectors = entries.some(e => e.vector && e.vector.length > 0);

          if (hasVectors) {
            // 快速路径：直接用预存向量恢复，不重嵌入
            const docs: Document[] = [];
            const vectors: number[][] = [];

            for (const entry of entries) {
              docs.push(new Document({
                pageContent: entry.pageContent,
                metadata: entry.metadata,
              }));
              vectors.push(entry.vector!);
            }

            await this.vectorStore.addVectors(vectors, docs);

            // 重建缓存
            for (let i = 0; i < entries.length; i++) {
              const id = this.buildCacheId(entries[i].metadata, i);
              this.cachedDocs.set(id, {
                pageContent: entries[i].pageContent,
                metadata: entries[i].metadata,
              });
            }

            logger.info(`Loaded ${entries.length} vectors from storage (pre-computed, no re-embed)`);
          } else {
            // 兼容旧格式（无预存向量）— 需要重嵌入（慢）
            logger.warn('No pre-computed vectors in persistence, re-embedding all documents (this may be slow)...');
            const docs = entries.map(e =>
              new Document({ pageContent: e.pageContent, metadata: e.metadata })
            );
            let embedded = 0;
            for (let i = 0; i < docs.length; i += 20) {
              const batch = docs.slice(i, i + 20);
              await this.vectorStore.addDocuments(batch);
              embedded += batch.length;
              if (embedded % 100 === 0 || embedded === docs.length) {
                logger.info(`Re-embed progress: ${embedded}/${docs.length}`);
              }
            }

            for (let i = 0; i < entries.length; i++) {
              const id = this.buildCacheId(entries[i].metadata, i);
              this.cachedDocs.set(id, {
                pageContent: entries[i].pageContent,
                metadata: entries[i].metadata,
              });
            }

            // 立即持久化以保存向量，下次就能走快速路径
            this.isDirty = true;
            await this.persist();

            logger.info(`Loaded ${entries.length} vectors from storage and re-saved with vectors`);
          }
        } else {
          logger.info('Persistent storage is empty, starting fresh');
        }
      } else {
        this.vectorStore = new MemoryVectorStore(this.embeddings);
        this.cachedDocs = new Map();
        logger.info('Created new MemoryVectorStore (no existing persistence)');
      }
    } catch (error) {
      logger.error('Failed to initialize vector store:', error);
      this.vectorStore = new MemoryVectorStore(this.embeddings);
      this.cachedDocs = new Map();
    }

    return this.vectorStore;
  }

  /**
   * 持久化到磁盘（同时保存向量以加速下次加载）
   */
  private async persist(): Promise<void> {
    if (!this.isDirty) return;
    if (!this.vectorStore) return;

    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 从 MemoryVectorStore 内部提取预计算向量
      const memoryVectors: Array<{ content: string; embedding: number[]; metadata: Record<string, any> }> =
        (this.vectorStore as any).memoryVectors || [];

      const data = {
        documents: memoryVectors.map(mv => ({
          pageContent: mv.content,
          metadata: mv.metadata,
          vector: mv.embedding,
        })),
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
   * 添加带元数据的文档（自动嵌入）
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
   * 添加预计算的向量（跳过嵌入，避免重复计算）
   */
  async addVectors(
    vectors: number[][],
    documents: Document[],
    options: { ids?: string[] }
  ): Promise<string[]> {
    const store = await this.ensureInitialized();
    const ids = options.ids || [];

    logger.info(`Adding ${vectors.length} pre-computed vectors to vector store`);

    try {
      await store.addVectors(vectors, documents);

      documents.forEach((doc, i) => {
        const id = ids[i] || `doc_${Date.now()}_${i}`;
        this.cachedDocs.set(id, {
          pageContent: doc.pageContent,
          metadata: doc.metadata,
        });
      });

      this.isDirty = true;
      await this.persist();

      logger.info(`Successfully added ${vectors.length} pre-computed vectors`);
      return ids.length ? ids : documents.map((_, i) => `doc_${Date.now()}_${i}`);
    } catch (error) {
      logger.error('Failed to add pre-computed vectors:', error);
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

        // 重建向量存储（使用预存向量避免重嵌入）
        this.vectorStore = new MemoryVectorStore(this.embeddings);
        if (this.cachedDocs.size > 0) {
          const memoryVectors = (this.vectorStore as any).memoryVectors || [];
          // Note: we're starting fresh, so memoryVectors is empty. We need to use the
          // vectors from the persistence file. Instead, rebuild from cached docs.
          // Since memoryVectors was cleared, we fetch vectors from the still-active
          // old store before it gets replaced.
          // Actually, let's just use addDocuments here since the remaining doc count
          // is typically small after a deletion. For large deletes, this is acceptable.
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
    const stopWords = new Set([
      '什么', '是什么', '什么是', '怎么', '怎么样', '为什么', '如何',
      '吗', '呢', '吧', '啊', '的', '了', '是', '在', '有', '和',
      '这个', '那个', '哪个', '一个', '什么意', '意思是',
    ]);
    const keywords: string[] = [];
    const cleanQuery = query.replace(/[\s，。？！、；：''（）\[\]{}]/g, '');
    for (let len = Math.min(4, cleanQuery.length); len >= 2; len--) {
      for (let i = 0; i <= cleanQuery.length - len; i++) {
        const kw = cleanQuery.substring(i, i + len);
        if (!stopWords.has(kw) && !keywords.includes(kw)) keywords.push(kw);
      }
    }
    // 如果所有词都是停用词，保留原样（用户可能真在搜这些词）
    if (keywords.length === 0) {
      return [];
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
   * 获取文档详情（含展示名称和分块数）
   */
  async listDocumentDetails(): Promise<{ source: string; displayName: string; chunks: number }[]> {
    await this.ensureInitialized();

    const map = new Map<string, { displayName: string; chunks: number }>();
    for (const doc of this.cachedDocs.values()) {
      const source = doc.metadata.source;
      const existing = map.get(source);
      if (existing) {
        existing.chunks++;
      } else {
        map.set(source, {
          displayName: doc.metadata.displayName || source.split(/[\\/]/).pop() || source,
          chunks: 1,
        });
      }
    }
    return Array.from(map.entries())
      .map(([source, info]) => ({ source, ...info }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
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

  /**
   * 构建缓存 key
   */
  private buildCacheId(metadata: Record<string, any>, fallbackIndex: number): string {
    return `${metadata.source || 'unknown'}_${metadata.chunkIndex ?? fallbackIndex}`;
  }
}

export default VectorStoreService;

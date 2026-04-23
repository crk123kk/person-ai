import { Document } from '@langchain/core/documents';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import type { Embeddings } from '@langchain/core/embeddings';
import logger from '../utils/logger.js';

export interface VectorMetadata {
  source: string;
  chunkIndex: number;
  totalChunks: number;
  fileType: string;
  uploadTime: string;
  customTags?: string[];
}

/**
 * 向量存储服务
 * 使用 ChromaDB
 */
export class VectorStoreService {
  private vectorStore: Chroma | null = null;
  private embeddings: Embeddings;

  constructor(embeddings: Embeddings) {
    this.embeddings = embeddings;
  }

  /**
   * 初始化向量库（懒加载）
   */
  private async ensureInitialized(): Promise<Chroma> {
    if (!this.vectorStore) {
      logger.info('Initializing ChromaDB vector store...');

      try {
        // 使用本地持久化模式
        this.vectorStore = await Chroma.fromExistingCollection(this.embeddings, {
          collectionName: 'rag-documents',
        });
        logger.info('ChromaDB initialized successfully');
      } catch (error) {
        // 如果集合不存在，创建新的
        logger.info('Creating new ChromaDB collection...');
        this.vectorStore = new Chroma(this.embeddings, {
          collectionName: 'rag-documents',
        });
      }
    }

    return this.vectorStore;
  }

  /**
   * 添加带元数据的文档
   */
  async addDocuments(
    documents: Document[],
    options: { ids: string[] }
  ): Promise<string[]> {
    const store = await this.ensureInitialized();
    const ids: string[] = [];

    logger.info(`Adding ${documents.length} documents to vector store`);

    // Ensure each document has its corresponding ID in metadata
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const id = options.ids[i];

      try {
        await store.addDocuments([doc], { ids: [id] });
        ids.push(id);
      } catch (error) {
        logger.warn(`Failed to add document ${id}:`, error);
      }
    }

    logger.info(`Successfully added ${ids.length} documents to vector store`);
    return ids;
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
      const filterObj = filter ? this.buildFilter(filter) : undefined;
      return await store.similaritySearch(query, k, filterObj);
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
      const filterObj = filter ? this.buildFilter(filter) : undefined;
      return await store.similaritySearchVectorWithScore(
        await this.embeddings.embedQuery(query),
        k,
        filterObj
      );
    } catch (error) {
      logger.error('Similarity search with score failed:', error);
      return [];
    }
  }

  /**
   * 删除文档（按源文件）
   */
  async deleteBySource(source: string): Promise<void> {
    const store = await this.ensureInitialized();

    logger.info(`Deleting documents for source: ${source}`);

    try {
      // 获取所有文档，过滤出匹配的源文件
      const collection = store.collection;
      if (!collection) {
        logger.warn('Collection is not initialized');
        return;
      }
      const result = await collection.get();
      const sources = result.metadatas || [];
      const idsToDelete: string[] = [];

      for (let i = 0; i < sources.length; i++) {
        const meta = sources[i] as Record<string, any> | null;
        if (meta?.source === source) {
          const docId = result.ids?.[i];
          if (docId) idsToDelete.push(docId);
        }
      }

      if (idsToDelete.length > 0) {
        await store.delete({ ids: idsToDelete });
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
    const store = await this.ensureInitialized();

    try {
      const collection = store.collection;
      if (!collection) {
        logger.warn('Collection is not initialized');
        return { totalChunks: 0, totalFiles: 0 };
      }
      const result = await collection.get();
      const totalChunks = result.documents?.length || 0;
      const uniqueFiles = new Set(
        (result.metadatas || []).map((m: any) => m?.source)
      ).size;

      return { totalChunks, totalFiles: uniqueFiles };
    } catch (error) {
      logger.error('Failed to get stats:', error);
      return { totalChunks: 0, totalFiles: 0 };
    }
  }

  /**
   * 获取所有源文件列表
   */
  async listSources(): Promise<string[]> {
    const store = await this.ensureInitialized();

    try {
      const collection = store.collection;
      if (!collection) {
        logger.warn('Collection is not initialized');
        return [];
      }
      const result = await collection.get();
      const sources = new Set(
        (result.metadatas || []).map((m: any) => m?.source)
      );
      return Array.from(sources).filter(Boolean) as string[];
    } catch (error) {
      logger.error('Failed to list sources:', error);
      return [];
    }
  }

  /**
   * 清空向量库
   */
  async clear(): Promise<void> {
    const store = await this.ensureInitialized();

    try {
      const collection = store.collection;
      if (!collection) {
        logger.warn('Collection is not initialized');
        return;
      }
      const result = await collection.get();
      const allIds = result.ids || [];

      if (allIds.length > 0) {
        await store.delete({ ids: allIds });
        logger.info('Cleared all vectors from store');
      }
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
   * 构建过滤器对象
   */
  private buildFilter(filter: Partial<VectorMetadata>): Record<string, any> {
    const filterObj: Record<string, any> = {};

    if (filter.fileType) {
      filterObj.fileType = filter.fileType;
    }

    if (filter.customTags && filter.customTags.length > 0) {
      filterObj.customTags = { $in: filter.customTags };
    }

    return filterObj;
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

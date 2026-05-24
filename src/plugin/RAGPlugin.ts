/**
 * RAG Plugin - 可复用的 RAG 服务插件
 *
 * 提供独立的 API 接口，方便外部项目集成：
 * - 网站爬取 + 入库
 * - 单网页添加
 * - 文档上传
 * - 对话问答
 * - 知识库管理
 *
 * @example
 * ```ts
 * import { RAGPlugin } from 'rag-assistant';
 *
 * const plugin = new RAGPlugin({ dataDir: './data' });
 * await plugin.init();
 *
 * // 爬取网站
 * const result = await plugin.crawlWebsite('https://example.com', { maxPages: 50 });
 *
 * // 添加单网页
 * await plugin.addWebpage('https://example.com/article');
 *
 * // 上传文档
 * await plugin.addDocument('./notes.md');
 *
 * // 对话
 * const answer = await plugin.ask('什么是 RAG？');
 * ```
 */

import { RAGService, IngestionResult, ChatResponse } from '../rag/RAGService.js';
import { WebCrawler, CrawlOptions, CrawlProgress, CrawlProgressCallback } from '../crawler/WebCrawler.js';
import { DataCleaner } from '../documents/DataCleaner.js';
import { TextSplitterFactory } from '../documents/TextSplitter.js';
import { EmbeddingService } from '../rag/EmbeddingService.js';
import { VectorStoreService, VectorMetadata } from '../rag/VectorStoreService.js';
import { Document } from '@langchain/core/documents';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';
import path from 'path';
import fs from 'fs';

// ===== 类型定义 =====

export interface PluginConfig {
  /** 数据存储目录，默认 ./data */
  dataDir?: string;
}

export interface CrawlWebsiteOptions extends CrawlOptions {
  /** 爬取进度回调 */
  onProgress?: CrawlProgressCallback;
}

export interface CrawlWebsiteResult {
  /** 爬取的页面数 */
  pagesCrawled: number;
  /** 入库的分块数 */
  totalChunks: number;
  /** 各页面详情 */
  pages: Array<{
    url: string;
    title: string;
    chunks: number;
  }>;
}

export interface WebpageResult {
  /** 页面标题 */
  title: string;
  /** 入库分块数 */
  chunks: number;
}

export interface DocumentInfo {
  source: string;
  displayName: string;
  fileType: string;
  chunks: number;
  uploadTime: string;
}

export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  documentCount: number;
  createdAt?: string;
}

// ===== 插件主类 =====

export class RAGPlugin {
  private dataDir: string;
  private ragInstances = new Map<string, RAGService>();

  constructor(pluginConfig: PluginConfig = {}) {
    this.dataDir = pluginConfig.dataDir || config.dataDir;
  }

  /**
   * 初始化插件（确保数据目录存在）
   */
  async init(): Promise<void> {
    const kbDir = path.resolve(this.dataDir, 'knowledge-bases');
    if (!fs.existsSync(kbDir)) {
      fs.mkdirSync(kbDir, { recursive: true });
    }
    logger.info('[RAGPlugin] Initialized, dataDir:', this.dataDir);
  }

  /**
   * 获取或创建 RAGService 实例
   */
  private getRag(kbId: string): RAGService {
    if (!this.ragInstances.has(kbId)) {
      this.ragInstances.set(kbId, new RAGService(kbId));
    }
    return this.ragInstances.get(kbId)!;
  }

  // ----- 网站爬取 -----

  /**
   * 爬取整个网站并加入知识库
   */
  async crawlWebsite(
    siteUrl: string,
    kbId: string = 'default',
    options: CrawlWebsiteOptions = {}
  ): Promise<CrawlWebsiteResult> {
    const { onProgress, ...crawlOpts } = options;

    // Phase 1: 爬取
    const documents = await WebCrawler.crawl(siteUrl, crawlOpts, onProgress);
    if (documents.length === 0) {
      return { pagesCrawled: 0, totalChunks: 0, pages: [] };
    }

    // Phase 2: 入库
    const result = await this.ingestDocuments(documents, siteUrl, 'web');

    // Phase 3: 保存网站记录
    const pages = result.map(r => ({
      url: r.documentId,
      title: r.documentId,
      chunks: r.totalChunks,
    }));
    const totalChunks = result.reduce((sum, r) => sum + r.totalChunks, 0);

    this.saveWebsiteRecord(kbId, siteUrl, totalChunks, pages);

    return { pagesCrawled: documents.length, totalChunks, pages };
  }

  /**
   * 添加单个网页到知识库
   */
  async addWebpage(
    url: string,
    kbId: string = 'default',
    onProgress?: CrawlProgressCallback
  ): Promise<WebpageResult> {
    const documents = await WebCrawler.crawl(url, { maxPages: 1, requestDelay: 0 }, onProgress);
    if (documents.length === 0) {
      throw new Error(`无法抓取网页: ${url}`);
    }

    const result = await this.ingestDocuments(documents, url, 'web');
    const totalChunks = result.reduce((sum, r) => sum + r.totalChunks, 0);
    const title = documents[0].metadata.title || url;

    // 保存网页记录
    this.saveWebsiteRecord(kbId, url, totalChunks, [{ url, title, chunks: totalChunks }]);

    return { title, chunks: totalChunks };
  }

  // ----- 文档管理 -----

  /**
   * 上传文档文件到知识库
   */
  async addDocument(
    filePath: string,
    kbId: string = 'default',
    displayName?: string
  ): Promise<IngestionResult> {
    const rag = this.getRag(kbId);
    return rag.addDocument(filePath, undefined, displayName);
  }

  /**
   * 列出知识库中的文档
   */
  async listDocuments(kbId: string = 'default'): Promise<DocumentInfo[]> {
    const rag = this.getRag(kbId);
    const docs = await rag.listDocuments();
    return docs
      .filter(d => !d.source.startsWith('http://') && !d.source.startsWith('https://'))
      .map(d => ({
        source: d.source,
        displayName: d.displayName || d.source,
        fileType: 'unknown',
        chunks: d.chunks,
        uploadTime: '',
      }));
  }

  /**
   * 删除文档
   */
  async removeDocument(source: string, kbId: string = 'default'): Promise<void> {
    const rag = this.getRag(kbId);
    await rag.removeDocument(source);
  }

  // ----- 网站管理 -----

  /**
   * 列出知识库中的网站记录
   */
  listWebsites(kbId: string = 'default'): Array<{
    url: string;
    chunks: number;
    addedAt: string;
    pages: Array<{ url: string; title: string; chunks: number }>;
  }> {
    const p = this.getWebsitesPath(kbId);
    if (!fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return [];
    }
  }

  /**
   * 删除网站记录
   */
  async removeWebsite(url: string, kbId: string = 'default'): Promise<void> {
    const websites = this.listWebsites(kbId);
    const updated = websites.filter(w => w.url !== url);
    fs.writeFileSync(this.getWebsitesPath(kbId), JSON.stringify(updated, null, 2), 'utf-8');
  }

  // ----- 对话问答 -----

  /**
   * 向知识库提问
   */
  async ask(
    question: string,
    kbId: string = 'default',
    sessionId?: string
  ): Promise<ChatResponse> {
    const rag = this.getRag(kbId);
    return rag.chat(question, sessionId);
  }

  // ----- 知识库管理 -----

  /**
   * 列出所有知识库
   */
  listKnowledgeBases(): KnowledgeBaseInfo[] {
    const kbDir = path.resolve(this.dataDir, 'knowledge-bases');
    if (!fs.existsSync(kbDir)) return [];

    return fs.readdirSync(kbDir)
      .filter(name => fs.statSync(path.join(kbDir, name)).isDirectory())
      .map(id => ({
        id,
        name: id,
        documentCount: 0, // 实际数量需查询 vector store
      }));
  }

  // ----- 内部方法 -----

  /**
   * 将爬取的文档入库（清洗 → 分块 → 向量化 → 存储）
   */
  private async ingestDocuments(
    documents: Document[],
    sourceUrl: string,
    fileType: string
  ): Promise<IngestionResult[]> {
    // 清洗
    const cleanedDocs = documents.map(doc => ({
      ...doc,
      pageContent: DataCleaner.cleanHTML(DataCleaner.clean(doc.pageContent)),
    }));

    // 分块
    const splitterConfig = TextSplitterFactory.getConfigForFileType('markdown');
    const chunks = await TextSplitterFactory.splitDocuments(cleanedDocs, splitterConfig);
    const nonEmptyChunks = chunks.filter(c => c.pageContent && c.pageContent.trim());

    if (nonEmptyChunks.length === 0) return [];

    // 向量化 + 存储（复用 EmbeddingService 单例）
    const embeddingService = EmbeddingService.getInstance();
    const embeddings = embeddingService.getEmbeddings();

    // 按 kbId 确定向量存储路径 — 使用 'default' 知识库
    const kbBase = path.resolve(this.dataDir, 'knowledge-bases', 'default');
    const vectorStore = new VectorStoreService(
      embeddings,
      path.join(kbBase, 'vectorstore', 'memory-store.json')
    );

    const BATCH_SIZE = 20;
    const allVectorIds: string[] = [];
    const results: IngestionResult[] = [];

    const chunksBySource = new Map<string, Document[]>();
    for (const chunk of nonEmptyChunks) {
      const src = chunk.metadata.source || sourceUrl;
      if (!chunksBySource.has(src)) chunksBySource.set(src, []);
      chunksBySource.get(src)!.push(chunk);
    }

    for (let batchStart = 0; batchStart < nonEmptyChunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, nonEmptyChunks.length);
      const batchChunks = nonEmptyChunks.slice(batchStart, batchEnd);

      const batchVectors = await embeddingService.embedDocuments(batchChunks.map(c => c.pageContent));

      const batchDocs = batchChunks.map((chunk, idx) => {
        const meta: VectorMetadata = {
          source: chunk.metadata.source || sourceUrl,
          displayName: chunk.metadata.title || chunk.metadata.source || sourceUrl,
          chunkIndex: batchStart + idx,
          totalChunks: nonEmptyChunks.length,
          fileType,
          uploadTime: new Date().toISOString(),
        };
        return new Document({ pageContent: chunk.pageContent, metadata: { ...chunk.metadata, ...meta } });
      });

      const safeIds = batchDocs.map((doc, idx) => {
        const src = doc.metadata.source || sourceUrl;
        const sanitized = src.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        return `${sanitized}_${batchStart + idx}`;
      });

      const storedIds = await vectorStore.addVectors(batchVectors, batchDocs, { ids: safeIds });
      allVectorIds.push(...storedIds);
    }

    for (const [source, sourceChunks] of chunksBySource) {
      results.push({
        documentId: source,
        totalChunks: sourceChunks.length,
        vectorIds: allVectorIds,
        stats: { totalChunks: sourceChunks.length, avgChunkSize: 0, minChunkSize: 0, maxChunkSize: 0 },
      });
    }

    logger.info(`[RAGPlugin] Ingested ${nonEmptyChunks.length} chunks from ${sourceUrl}`);
    return results;
  }

  private getWebsitesPath(kbId: string): string {
    const kbBase = path.resolve(this.dataDir, 'knowledge-bases', kbId);
    return path.join(kbBase, 'websites.json');
  }

  private saveWebsiteRecord(
    kbId: string,
    url: string,
    totalChunks: number,
    pages: Array<{ url: string; title: string; chunks: number }>
  ): void {
    const p = this.getWebsitesPath(kbId);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let websites: any[] = [];
    if (fs.existsSync(p)) {
      try { websites = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { websites = []; }
    }

    const existing = websites.findIndex(w => w.url === url);
    const record = { url, chunks: totalChunks, addedAt: new Date().toISOString(), status: 'completed' as const, pages };

    if (existing >= 0) {
      websites[existing] = record;
    } else {
      websites.push(record);
    }

    fs.writeFileSync(p, JSON.stringify(websites, null, 2), 'utf-8');
  }
}

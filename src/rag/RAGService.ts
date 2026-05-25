import { Document } from '@langchain/core/documents';
import { ChatHistoryManager, Message } from '../utils/ChatHistoryManager.js';
import { QueryCache, ContextManager } from '../utils/cache.js';
import { retryWithBackoff, CircuitBreaker, withTimeout } from '../utils/retry.js';
import { DocumentLoader } from '../documents/DocumentLoader.js';
import { DataCleaner } from '../documents/DataCleaner.js';
import { TextSplitterFactory, ChunkStatsCalculator } from '../documents/TextSplitter.js';
import { EmbeddingService } from './EmbeddingService.js';
import { VectorStoreService, VectorMetadata } from './VectorStoreService.js';
import { LLMProviderFactory, LLMRouter, LLMProviderType } from '../models/LLMProvider.js';
import { WebCrawler, CrawlProgress } from '../crawler/WebCrawler.js';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import { ProgressManager } from '../utils/UploadProgress.js';

/**
 * 检索结果
 */
export interface RetrievalResult {
  documents: Document[];
  scores?: number[];
}

/**
 * 问答结果
 */
export interface ChatResponse {
  answer: string;
  sources: {
    content: string;
    metadata: any;
    score?: number;
  }[];
  sessionId: string;
}

/**
 * 文档处理结果
 */
export interface IngestionResult {
  documentId: string;
  totalChunks: number;
  vectorIds: string[];
  stats: {
    totalChunks: number;
    avgChunkSize: number;
    minChunkSize: number;
    maxChunkSize: number;
  };
}

/**
 * RAG 核心服务
 * 整合文档加载、清洗、分块、向量化、检索、生成
 */
export class RAGService {
  private embeddingService: EmbeddingService;
  private vectorStore: VectorStoreService;
  private llmRouter: LLMRouter;
  private queryCache: QueryCache;
  private contextManager: ContextManager;
  private chatHistory: ChatHistoryManager;
  private circuitBreaker: CircuitBreaker;
  private kbId: string;
  private customSystemPrompt: string = '';

  constructor(kbId?: string) {
    this.kbId = kbId || 'default';
    logger.info(`Initializing RAG service${kbId ? ` for KB: ${kbId}` : ''}...`);

    this.embeddingService = EmbeddingService.getInstance();

    if (kbId) {
      const kbBase = path.resolve(config.dataDir, 'knowledge-bases', kbId);
      this.vectorStore = new VectorStoreService(
        this.embeddingService.getEmbeddings(),
        path.join(kbBase, 'vectorstore', 'memory-store.json')
      );
      this.chatHistory = new ChatHistoryManager(path.join(kbBase, 'chat-history'));
    } else {
      this.vectorStore = new VectorStoreService(this.embeddingService.getEmbeddings());
      this.chatHistory = new ChatHistoryManager();
    }

    this.llmRouter = new LLMRouter(config.llmProvider, ['anthropic', 'ollama', 'openai'].filter(p => p !== config.llmProvider) as LLMProviderType[]);
    this.queryCache = new QueryCache({ ttl: config.queryCacheTtl });
    this.contextManager = new ContextManager({ strategy: config.contextStrategy });
    this.circuitBreaker = new CircuitBreaker();

    logger.info(`RAG service initialized${kbId ? ` for KB: ${kbId}` : ''}`);
  }

  /** Set custom system prompt for this KB */
  setSystemPrompt(prompt: string): void {
    this.customSystemPrompt = prompt;
  }

  /**
   * 添加文档到知识库
   */
  async addDocument(filePath: string, fileId?: string, displayName?: string): Promise<IngestionResult> {
    const progressManager = fileId ? ProgressManager.getInstance() : null;
    const fid = fileId!; // guaranteed non-null when progressManager is non-null

    logger.info(`[Pipeline] Processing: ${filePath}`);

    // Step 1: 加载文档
    if (progressManager) {
      progressManager.updateStage(fid, 'load', { status: 'processing', progress: 0 });
    }
    const loaded = await DocumentLoader.load(filePath);
    if (progressManager) {
      progressManager.updateStage(fid, 'load', { status: 'completed', progress: 100 });
    }
    logger.info(`[Pipeline] Loaded ${loaded.documents.length} documents`);

    // Step 2: 数据清洗
    if (progressManager) {
      progressManager.updateStage(fid, 'clean', { status: 'processing', progress: 0 });
    }
    const fileType = loaded.metadata.fileType;
    const cleanedDocs = loaded.documents.map(doc => ({
      ...doc,
      pageContent: fileType === 'pdf'
        ? DataCleaner.cleanPDFArtifacts(DataCleaner.clean(doc.pageContent))
        : fileType === 'code'
        ? DataCleaner.cleanCode(doc.pageContent, doc.metadata.language || 'unknown')
        : fileType === 'markdown'
        ? DataCleaner.cleanMarkdown(doc.pageContent)
        : DataCleaner.clean(doc.pageContent),
    }));
    if (progressManager) {
      progressManager.updateStage(fid, 'clean', { status: 'completed', progress: 100 });
    }
    logger.info(`[Pipeline] Cleaned ${cleanedDocs.length} documents`);

    // Step 3: 文本分块
    if (progressManager) {
      progressManager.updateStage(fid, 'split', { status: 'processing', progress: 0 });
    }
    const splitterConfig = TextSplitterFactory.getConfigForFileType(fileType, loaded.documents[0]?.metadata);
    const chunks = await TextSplitterFactory.splitDocuments(cleanedDocs, splitterConfig);
    if (progressManager) {
      progressManager.updateStage(fid, 'split', { status: 'completed', progress: 100 });
    }
    logger.info(`[Pipeline] Split into ${chunks.length} chunks`);

    // 统计信息
    const stats = ChunkStatsCalculator.calculate(chunks);
    ChunkStatsCalculator.logStats(stats, filePath);

    // Step 4+5: 分批向量化 + 存储（流式处理，避免内存堆积和二次嵌入）
    // Filter out empty chunks that can cause Ollama to return NaN
    const nonEmptyChunks = chunks.filter(c => c.pageContent && c.pageContent.trim());
    if (nonEmptyChunks.length < chunks.length) {
      logger.warn(`Filtered ${chunks.length - nonEmptyChunks.length} empty chunks before embedding`);
    }

    if (progressManager) {
      progressManager.updateStage(fid, 'embed', { status: 'processing', progress: 0, message: `向量化中：0/${nonEmptyChunks.length}` });
    }

    const BATCH_SIZE = 20; // 每批处理 20 个 chunk：嵌入 → 立即存储 → 释放内存
    const allVectorIds: string[] = [];
    let globalChunkIdx = 0;

    for (let batchStart = 0; batchStart < nonEmptyChunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, nonEmptyChunks.length);
      const batchChunks = nonEmptyChunks.slice(batchStart, batchEnd);
      const batchTexts = batchChunks.map(c => c.pageContent);
      const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;

      // Step 4: 嵌入当前批次
      const batchVectors = await this.embeddingService.embedDocuments(batchTexts);

      const embedPercent = Math.round((batchEnd / nonEmptyChunks.length) * 100);
      if (progressManager) {
        progressManager.updateStage(fid, 'embed', { progress: embedPercent, message: `向量化：${batchEnd}/${nonEmptyChunks.length}` });
      }

      // 构建带元数据的文档
      const batchDocs = batchChunks.map((chunk) => {
        const meta: VectorMetadata = {
          source: filePath,
          displayName,
          chunkIndex: globalChunkIdx,
          totalChunks: nonEmptyChunks.length,
          fileType,
          uploadTime: loaded.metadata.uploadTime,
        };
        globalChunkIdx++;
        return new Document({
          pageContent: chunk.pageContent,
          metadata: { ...chunk.metadata, ...meta },
        });
      });

      // Step 5: 存储向量（用预计算向量直接存储，避免 MemoryVectorStore 内部二次嵌入）
      const batchIds = batchDocs.map((_, idx) => `${VectorStoreService.sanitizeId(filePath)}_${batchStart + idx}`);
      const storedIds = await this.vectorStore.addVectors(batchVectors, batchDocs, { ids: batchIds, skipPersist: true });
      allVectorIds.push(...storedIds);

      // 更新存储进度（与向量化同步推进）
      if (progressManager) {
        if (batchStart === 0) {
          progressManager.updateStage(fid, 'store', { status: 'processing', progress: 0 });
        }
        const storePercent = Math.round((batchEnd / nonEmptyChunks.length) * 100);
        progressManager.updateStage(fid, 'store', { progress: storePercent, message: `存储：${batchEnd}/${nonEmptyChunks.length}` });
      }

      // 日志输出整体进度（与前端进度条数值一致）
      const overall = progressManager?.getProgress(fid)?.overallProgress ?? embedPercent;
      logger.info(`[Pipeline] Batch ${batchNum}: ${batchEnd}/${nonEmptyChunks.length}, overall ${overall}%`);
    }

    if (progressManager) {
      progressManager.updateStage(fid, 'embed', { status: 'completed', progress: 100 });
      progressManager.updateStage(fid, 'store', { status: 'completed', progress: 100 });
    }

    // 所有批次写入内存后，一次性持久化到磁盘
    await this.vectorStore.flush();
    logger.info(`[Pipeline] Done: ${allVectorIds.length} vectors embedded+stored`);

    return {
      documentId: filePath,
      totalChunks: nonEmptyChunks.length,
      vectorIds: allVectorIds,
      stats,
    };
  }

  /**
   * 添加目录
   */
  async addDirectory(dirPath: string, recursive: boolean = true): Promise<IngestionResult[]> {
    const loaded = await DocumentLoader.loadDirectory(dirPath, recursive);
    const results: IngestionResult[] = [];

    for (const doc of loaded) {
      try {
        const result = await this.addDocument(doc.metadata.source);
        results.push(result);
      } catch (error) {
        logger.warn(`Failed to process ${doc.metadata.source}:`, error);
      }
    }

    return results;
  }

  /**
   * 爬取网站并添加到知识库
   */
  async addWebDocuments(
    siteUrl: string,
    fileId: string,
    options: { maxPages?: number; requestDelay?: number } = {}
  ): Promise<IngestionResult[]> {
    const progressManager = ProgressManager.getInstance();

    // Phase 1: 爬取网站
    progressManager.updateStage(fileId, 'load', { status: 'processing', progress: 0, message: `正在发现 ${siteUrl} 的文章...` });

    const documents = await WebCrawler.crawl(
      siteUrl,
      options,
      (crawlProgress: CrawlProgress) => {
        if (crawlProgress.phase === 'discovering') {
          progressManager.updateStage(fileId, 'load', { progress: 10, message: crawlProgress.message });
        } else if (crawlProgress.phase === 'crawling') {
          const percent = crawlProgress.total
            ? Math.round((crawlProgress.current! / crawlProgress.total) * 100)
            : 50;
          progressManager.updateStage(fileId, 'load', {
            progress: percent,
            message: crawlProgress.message,
          });
        } else if (crawlProgress.phase === 'done') {
          progressManager.updateStage(fileId, 'load', { status: 'completed', progress: 100, message: crawlProgress.message });
        } else if (crawlProgress.phase === 'failed') {
          progressManager.updateStage(fileId, 'load', { status: 'completed', progress: 100, message: crawlProgress.message });
        }
      }
    );

    if (documents.length === 0) {
      progressManager.updateStatus(fileId, 'failed', '未抓取到任何内容');
      return [];
    }

    logger.info(`[WebPipeline] Crawled ${documents.length} pages from ${siteUrl}`);

    // Phase 2: 清洗
    progressManager.updateStage(fileId, 'clean', { status: 'processing', progress: 0 });
    const cleanedDocs = documents.map(doc => ({
      ...doc,
      pageContent: DataCleaner.cleanHTML(DataCleaner.clean(doc.pageContent)),
    }));
    progressManager.updateStage(fileId, 'clean', { status: 'completed', progress: 100 });

    // Phase 3: 分块
    progressManager.updateStage(fileId, 'split', { status: 'processing', progress: 0 });
    const splitterConfig = TextSplitterFactory.getConfigForFileType('markdown');
    const chunks = await TextSplitterFactory.splitDocuments(cleanedDocs, splitterConfig);
    progressManager.updateStage(fileId, 'split', { status: 'completed', progress: 100 });
    logger.info(`[WebPipeline] Split into ${chunks.length} chunks`);

    const nonEmptyChunks = chunks.filter(c => c.pageContent && c.pageContent.trim());

    // Phase 4+5: 嵌入 + 存储
    progressManager.updateStage(fileId, 'embed', { status: 'processing', progress: 0, message: `向量化中：0/${nonEmptyChunks.length}` });

    const BATCH_SIZE = 20;
    const allVectorIds: string[] = [];
    let globalChunkIdx = 0;
    const results: IngestionResult[] = [];

    // 按来源分组，每个来源一个 IngestionResult
    const chunksBySource = new Map<string, Document[]>();
    for (const chunk of nonEmptyChunks) {
      const source = chunk.metadata.source || siteUrl;
      if (!chunksBySource.has(source)) chunksBySource.set(source, []);
      chunksBySource.get(source)!.push(chunk);
    }

    for (let batchStart = 0; batchStart < nonEmptyChunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, nonEmptyChunks.length);
      const batchChunks = nonEmptyChunks.slice(batchStart, batchEnd);
      const batchTexts = batchChunks.map(c => c.pageContent);

      const batchVectors = await this.embeddingService.embedDocuments(batchTexts);

      const embedPercent = Math.round((batchEnd / nonEmptyChunks.length) * 100);
      progressManager.updateStage(fileId, 'embed', { progress: embedPercent, message: `向量化：${batchEnd}/${nonEmptyChunks.length}` });

      const batchDocs = batchChunks.map((chunk) => {
        const meta: VectorMetadata = {
          source: chunk.metadata.source || siteUrl,
          displayName: chunk.metadata.title || chunk.metadata.source || siteUrl,
          chunkIndex: globalChunkIdx,
          totalChunks: nonEmptyChunks.length,
          fileType: 'web',
          uploadTime: new Date().toISOString(),
        };
        globalChunkIdx++;
        return new Document({
          pageContent: chunk.pageContent,
          metadata: { ...chunk.metadata, ...meta },
        });
      });

      // 使用 source 作为 ID 前缀
      const safeIds = batchDocs.map((doc, idx) => {
        const src = doc.metadata.source || siteUrl;
        const sanitized = src.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        return `${sanitized}_${batchStart + idx}`;
      });

      const storedIds = await this.vectorStore.addVectors(batchVectors, batchDocs, { ids: safeIds, skipPersist: true });
      allVectorIds.push(...storedIds);

      if (progressManager) {
        if (batchStart === 0) {
          progressManager.updateStage(fileId, 'store', { status: 'processing', progress: 0 });
        }
        const storePercent = Math.round((batchEnd / nonEmptyChunks.length) * 100);
        progressManager.updateStage(fileId, 'store', { progress: storePercent, message: `存储：${batchEnd}/${nonEmptyChunks.length}` });
      }
    }

    progressManager.updateStage(fileId, 'embed', { status: 'completed', progress: 100 });
    progressManager.updateStage(fileId, 'store', { status: 'completed', progress: 100 });

    // 所有批次写入内存后，一次性持久化到磁盘
    await this.vectorStore.flush();
    logger.info(`[WebPipeline] Done: ${allVectorIds.length} vectors embedded+stored`);

    // 返回按来源分组的结果
    for (const [source, sourceChunks] of chunksBySource) {
      results.push({
        documentId: source,
        totalChunks: sourceChunks.length,
        vectorIds: allVectorIds,
        stats: { totalChunks: sourceChunks.length, avgChunkSize: 0, minChunkSize: 0, maxChunkSize: 0 },
      });
    }

    return results;
  }

  /**
   * 检索文档
   */
  async retrieve(
    query: string,
    topK: number = config.defaultTopK,
    useCache: boolean = true
  ): Promise<RetrievalResult> {
    // 检查缓存
    if (useCache) {
      const cached = this.queryCache.get(query);
      if (cached) {
        logger.info('Cache hit for query');
        return { documents: cached };
      }
    }

    // 带熔断的检索
    const documents = await this.circuitBreaker.execute(async () => {
      return withTimeout(
        () => this.vectorStore.similaritySearch(query, topK),
        config.llmTimeout,
        'Retrieval timeout'
      );
    });

    // 缓存结果
    if (useCache && documents.length > 0) {
      this.queryCache.set(query, documents);
    }

    return { documents };
  }

  /**
   * 检索带分数（向量 + 关键词混合检索）
   */
  async retrieveWithScore(
    query: string,
    topK: number = config.defaultTopK
  ): Promise<RetrievalResult & { scores: number[] }> {
    // 1. 向量检索（扩大候选池，确保多来源不被单一文档淹没）
    const candidateK = topK * 10;
    const vectorResults = await this.circuitBreaker.execute(async () => {
      return this.vectorStore.similaritySearchWithScore(query, candidateK);
    });

    // 2. 关键词检索（弥补中文 embedding 精度不足）
    const keywordResults = this.vectorStore.keywordSearch(query, topK);

    // 3. 合并：用 (source + chunkIndex) 作为 key 去重
    const seen = new Map<string, { doc: Document; score: number }>();

    // 向量结果归一化
    let maxVecScore = 0;
    for (const [, score] of vectorResults) {
      if (score > maxVecScore) maxVecScore = score;
    }
    for (const [doc, score] of vectorResults) {
      const key = doc.metadata.source + '@' + (doc.metadata.chunkIndex ?? doc.metadata.page ?? '');
      const normalizedScore = maxVecScore > 0 ? score / maxVecScore : 0;
      if (!seen.has(key) || seen.get(key)!.score < normalizedScore) {
        seen.set(key, { doc, score: normalizedScore * 0.6 });
      }
    }

    // 关键词结果合并
    for (const { doc, score } of keywordResults) {
      const key = doc.metadata.source + '@' + (doc.metadata.chunkIndex ?? doc.metadata.page ?? '');
      const keywordBoost = score * 0.4;
      if (seen.has(key)) {
        seen.get(key)!.score += keywordBoost;
      } else {
        const d = new Document({ pageContent: doc.pageContent, metadata: doc.metadata });
        seen.set(key, { doc: d, score: keywordBoost });
      }
    }

    // 4. 按合并分数降序排列，过滤低分，取 topK
    const deduped = Array.from(seen.values())
      .filter(r => r.score >= 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const documents = deduped.map(r => r.doc);
    const scores = deduped.map(r => r.score);

    logger.info('Retrieved ' + vectorResults.length + ' vector + ' + keywordResults.length + ' keyword, ' + deduped.length + ' merged, top score: ' + (scores[0] ? scores[0].toFixed(3) : 'N/A'));

    return { documents, scores };
  }

  /**
   * 问答（无会话）
   */
  async query(question: string): Promise<ChatResponse> {
    // 检索
    const { documents, scores } = await this.retrieveWithScore(question);

    if (documents.length === 0) {
      // 无检索结果，降级处理
      return this.handleNoResults(question);
    }

    // 构建 prompt
    const context = this.buildContext(documents);
    const prompt = this.buildPrompt(question, context);

    // 调用 LLM
    const answer = await this.generateAnswer(prompt);

    return {
      answer,
      sources: documents.map((doc, idx) => ({
        content: doc.pageContent,
        metadata: doc.metadata,
        score: scores?.[idx],
      })),
      sessionId: '',
    };
  }

  /**
   * 流式问答（带会话）— 真正的逐 token 流式输出
   */
  async *chatStream(
    question: string,
    sessionId?: string
  ): AsyncGenerator<{
    type: 'sources' | 'token' | 'done' | 'thinking';
    sources?: { content: string; metadata: any; score?: number }[];
    sessionId?: string;
    token?: string;
    message?: string;
  }> {
    // 获取或创建会话
    let session = sessionId
      ? this.chatHistory.getSession(sessionId)
      : this.chatHistory.createSession();

    if (!session) {
      session = this.chatHistory.createSession();
    }

    // 添加用户消息
    this.chatHistory.addUserMessage(session.id, question);

    // 检索
    const { documents: rawDocs, scores: rawScores } = await this.retrieveWithScore(question);

    // retrieveWithScore 已过滤 score >= 0.6，空结果即无匹配
    if (rawDocs.length === 0) {
      this.logUnansweredQuestion(question);
      yield { type: 'token', token: '抱歉，知识库中没有找到与您问题相关的内容。请尝试换个方式提问。' };
      yield { type: 'done', sessionId: session.id };
      return;
    }

    const documents = rawDocs;
    const scores = rawScores;

    // 更新会话的向量 ID
    const vectorIds = documents.map(d => d.metadata.source);
    this.chatHistory.updateVectorIds(session.id, vectorIds);

    // 先发送 sources
    yield {
      type: 'sources',
      sources: documents.map((doc, idx) => ({
        content: doc.pageContent,
        metadata: doc.metadata,
        score: scores?.[idx],
      })),
      sessionId: session.id,
    };

    // 通知前端：检索完成，正在生成回答
    yield { type: 'thinking', message: '已找到相关文档，正在生成回答...' };

    // 构建 prompt 并流式生成
    const context = this.buildContext(documents);
    const prompt = this.buildPrompt(question, context, session.messages);

    let fullAnswer = '';
    for await (const chunk of this.llmRouter.stream(prompt)) {
      if (chunk.done) break;
      fullAnswer += chunk.content;
      yield { type: 'token', token: chunk.content };
    }

    // LLM 判断无法回答时，清空参考来源
    if (fullAnswer.includes('未找到相关内容')) {
      yield { type: 'sources', sources: [] };
    }

    // 保存助手消息
    this.chatHistory.addAssistantMessage(
      session.id,
      fullAnswer,
      documents.map(d => d.metadata.source)
    );

    yield { type: 'done', sessionId: session.id };
  }

  /**
   * 获取模型状态（检查 Ollama 模型是否已加载）
   */
  async getModelStatus(): Promise<{
    provider: string;
    model: string;
    loaded: boolean;
    loading: boolean;
  }> {
    const provider = config.llmProvider;
    const model = provider === 'ollama' ? (config.ollamaModel || 'llama3') :
                  provider === 'openai' ? 'gpt-4o-mini' :
                  'claude-sonnet-4-6-20250929';

    if (provider !== 'ollama') {
      return { provider, model, loaded: true, loading: false };
    }

    try {
      const resp = await fetch(`${config.ollamaBaseUrl}/api/ps`);
      const data = await resp.json() as { models: { name: string }[] };
      const loaded = data.models?.some((m: { name: string }) => m.name === model) ?? false;
      return { provider, model, loaded, loading: false };
    } catch {
      return { provider, model, loaded: false, loading: false };
    }
  }

  /**
   * 预热 LLM 模型（让 Ollama 提前加载模型到内存）
   */
  async warmUp(): Promise<void> {
    logger.info('Warming up LLM model...');
    try {
      const result = await this.llmRouter.invoke('hi');
      logger.info(`LLM warm-up successful, provider: ${this.llmRouter.getCurrentProvider()}`);
    } catch (error) {
      logger.warn('LLM warm-up failed:', error);
      throw error;
    }
  }

  /**
   * 问答（带会话）
   */
  async chat(question: string, sessionId?: string): Promise<ChatResponse> {
    // 获取或创建会话
    let session = sessionId
      ? this.chatHistory.getSession(sessionId)
      : this.chatHistory.createSession();

    if (!session) {
      session = this.chatHistory.createSession();
    }

    // 添加用户消息
    this.chatHistory.addUserMessage(session.id, question);

    // 检索（retrieveWithScore 已过滤 score >= 0.6）
    const { documents, scores } = await this.retrieveWithScore(question);

    if (documents.length === 0) {
      const response = await this.handleNoResults(question);
      this.chatHistory.addAssistantMessage(session.id, response.answer);
      return { ...response, sessionId: session.id };
    }

    // 更新会话的向量 ID
    const vectorIds = documents.map(d => d.metadata.source);
    this.chatHistory.updateVectorIds(session.id, vectorIds);

    // 构建上下文（包含对话历史）
    const context = this.buildContext(documents);
    const prompt = this.buildPrompt(question, context, session.messages);

    // 调用 LLM
    const answer = await this.generateAnswer(prompt);

    // 添加助手消息
    this.chatHistory.addAssistantMessage(
      session.id,
      answer,
      documents.map(d => d.metadata.source)
    );

    return {
      answer,
      sources: documents.map((doc, idx) => ({
        content: doc.pageContent,
        metadata: doc.metadata,
        score: scores?.[idx],
      })),
      sessionId: session.id,
    };
  }

  /**
   * 列出知识库中的文档（含展示名称和分块数）
   */
  async listDocuments(): Promise<{ source: string; displayName: string; chunks: number }[]> {
    return this.vectorStore.listDocumentDetails();
  }

  /**
   * 删除文档
   */
  async removeDocument(source: string): Promise<void> {
    await this.vectorStore.deleteBySource(source);
    // 清空查询缓存
    this.queryCache.clear();
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<{
    vectorStore: { totalChunks: number; totalFiles: number };
    chatHistory: { totalSessions: number; totalMessages: number };
    cache: { size: number; ttl: number };
  }> {
    const [vectorStore, chatHistory, cache] = await Promise.all([
      this.vectorStore.getStats(),
      this.chatHistory.getStats(),
      this.queryCache.getStats(),
    ]);

    return { vectorStore, chatHistory, cache };
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<{
    embedding: boolean;
    vectorStore: boolean;
    llm: boolean;
    overall: boolean;
  }> {
    const [embedding, vectorStore, llm] = await Promise.all([
      this.embeddingService.healthCheck(),
      this.vectorStore.healthCheck(),
      LLMProviderFactory.healthCheck(),
    ]);

    return {
      embedding,
      vectorStore,
      llm,
      overall: embedding && vectorStore && llm,
    };
  }

  /**
   * 构建上下文
   */
  private buildContext(documents: Document[]): string {
    return documents
      .map((doc, idx) => `[Context ${idx + 1}]\n${doc.pageContent}`)
      .join('\n\n');
  }

  /**
   * 构建 Prompt
   */
  private buildPrompt(
    question: string,
    context: string,
    history?: Message[]
  ): string {
    const defaultSystemPrompt = `你是一个 RAG 智能助手，你的知识完全来源于下方提供的「检索内容」。

你需要做的是：
- 理解用户的问题，从检索内容中找到相关信息
- 对相关内容进行梳理、归纳，用清晰的结构（标题、分点、列表）呈现给用户
- 只输出检索内容中有的信息，不推测、不补充、不扩展
- 若检索内容无法回答用户问题，直接告知用户"当前知识库中未找到相关内容"`;

    const systemPrompt = this.customSystemPrompt || defaultSystemPrompt;

    // Extract blocked words and add explicit instruction
    let blockedInstruction = '';
    const blockedMatch = systemPrompt.match(/【屏蔽词】\n([\s\S]*?)(?=\n【|$)/);
    if (blockedMatch && blockedMatch[1].trim()) {
      const words = blockedMatch[1].trim().split('\n').map(w => w.trim()).filter(Boolean);
      if (words.length > 0) {
        blockedInstruction = `\n\n重要：回答中绝对不能包含以下词汇：${words.join('、')}。如果检索内容中包含这些词汇，必须用「***」替代。`;
      }
    }

    const fullPrompt = `${systemPrompt}${blockedInstruction}

检索内容：
${context}
`;

    if (history && history.length > 0) {
      const historyText = history
        .slice(-6)
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');
      return `${fullPrompt}\n对话历史:\n${historyText}\n\n用户：${question}\n助手:`;
    }

    return `${fullPrompt}\n用户：${question}\n助手:`;
  }

  /**
   * 生成回答
   */
  private async generateAnswer(prompt: string): Promise<string> {
    return retryWithBackoff(
      () => this.llmRouter.invoke(prompt),
      { maxRetries: config.embeddingMaxRetries }
    );
  }

  /**
   * 处理无检索结果
   */
  private async handleNoResults(question: string): Promise<ChatResponse> {
    logger.info('No retrieval results, returning no-match response');
    this.logUnansweredQuestion(question);

    return {
      answer: '抱歉，我在知识库中没有找到与您问题相关的内容，请尝试换个方式提问，或先上传相关文档到知识库。',
      sources: [],
      sessionId: '',
    };
  }

  /**
   * 记录未匹配到知识库内容的问题到本地 markdown 文件
   */
  private logUnansweredQuestion(question: string): void {
    try {
      const logDir = path.resolve(config.dataDir, 'unanswered');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logPath = path.join(logDir, `${this.kbId}.md`);
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const entry = `| ${timestamp} | ${question} |\n`;
      if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, `# 未匹配到知识库内容的问题\n\n| 时间 | 问题 |\n| --- | --- |\n${entry}`, 'utf-8');
      } else {
        fs.appendFileSync(logPath, entry, 'utf-8');
      }
      logger.info(`Logged unanswered question to ${logPath}`);
    } catch (err) {
      logger.warn('Failed to log unanswered question:', err);
    }
  }
}

export default RAGService;

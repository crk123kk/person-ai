import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { RAGService } from './rag/RAGService.js';
import { KnowledgeBaseManager } from './rag/KnowledgeBaseManager.js';
import { ChatHistoryManager } from './utils/ChatHistoryManager.js';
import { config } from './utils/config.js';
import logger from './utils/logger.js';
import { ProgressManager } from './utils/UploadProgress.js';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== Website storage helpers =====

interface WebsitePage {
  url: string;
  title: string;
  chunks: number;
}

interface WebsiteRecord {
  url: string;
  chunks: number;
  addedAt: string;
  status: 'completed' | 'failed';
  pages: WebsitePage[];
}

function getWebsitesPath(kbId: string): string {
  const kbBase = path.resolve(config.dataDir, 'knowledge-bases', kbId);
  return path.join(kbBase, 'websites.json');
}

function listWebsites(kbId: string): WebsiteRecord[] {
  const p = getWebsitesPath(kbId);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

/** Extract domain from URL for grouping */
function getSiteRoot(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url;
  }
}

/** Check if a page URL belongs to a site */
function isPageOfSite(pageUrl: string, siteUrl: string): boolean {
  try {
    const pageHost = new URL(pageUrl).hostname;
    const siteHost = new URL(siteUrl).hostname;
    return pageHost === siteHost;
  } catch {
    return false;
  }
}

function saveWebsite(kbId: string, url: string, chunks: number, pages?: WebsitePage[]): void {
  const websites = listWebsites(kbId);
  const existing = websites.findIndex((w: WebsiteRecord) => w.url === url);
  const record: WebsiteRecord = {
    url,
    chunks,
    addedAt: new Date().toISOString(),
    status: 'completed',
    pages: pages || [],
  };
  if (existing >= 0) {
    websites[existing] = record;
  } else {
    websites.push(record);
  }
  fs.writeFileSync(getWebsitesPath(kbId), JSON.stringify(websites, null, 2), 'utf-8');
}

function removeWebsite(kbId: string, url: string): boolean {
  const websites = listWebsites(kbId);
  const idx = websites.findIndex((w: WebsiteRecord) => w.url === url);
  if (idx < 0) return false;
  websites.splice(idx, 1);
  fs.writeFileSync(getWebsitesPath(kbId), JSON.stringify(websites, null, 2), 'utf-8');
  return true;
}

// ===== End website storage helpers =====

/**
 * 启动 Web 服务器
 */
export async function startServer(port: number): Promise<number> {
  const app = express();
  const kbManager = new KnowledgeBaseManager();
  const ragInstances = new Map<string, RAGService>();

  // 确保至少有一个知识库
  kbManager.ensureDefault();

  // 中间件
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // 获取或创建 RAGService 实例（懒加载）
  function getRagService(kbId: string): RAGService {
    if (!ragInstances.has(kbId)) {
      const rag = new RAGService(kbId);
      const kb = kbManager.get(kbId);
      if (kb?.systemPrompt) {
        rag.setSystemPrompt(kb.systemPrompt);
      }
      ragInstances.set(kbId, rag);
    }
    return ragInstances.get(kbId)!;
  }

  // 获取 KB 范围的 ChatHistoryManager
  function getChatHistory(kbId: string): ChatHistoryManager {
    const kbBase = path.resolve(config.dataDir, 'knowledge-bases', kbId);
    return new ChatHistoryManager(path.join(kbBase, 'chat-history'));
  }

  // 创建 KB 范围的 multer upload 实例
  function createUpload(kbId: string) {
    const uploadDir = kbManager.getDocumentsDir(kbId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
      },
    });

    const fileFilter = (_req: any, file: any, cb: any) => {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const allowedExtensions = [
        '.pdf', '.md', '.markdown', '.txt', '.text',
        '.docx',
        '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs',
      ];
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowedExtensions.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`不支持的文件类型：${ext}`), false);
      }
    };

    return multer({ storage, fileFilter, limits: { fileSize: 200 * 1024 * 1024 } });
  }

  // ===== 知识库管理 =====

  app.get('/api/kb', (_req, res) => {
    res.json({ knowledgeBases: kbManager.list() });
  });

  app.post('/api/kb', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: '缺少 name 参数' });
    const kb = kbManager.create(name);
    res.json(kb);
  });

  // 智能客服专用：确保插件知识库存在（不存在则自动创建）
  const WIDGET_KB_NAME = '阿里国际站';
  app.get('/api/widget/kb', (_req, res) => {
    const list = kbManager.list();
    // 查找名为「智能客服」的知识库
    let kb = list.find(k => k.name === WIDGET_KB_NAME);
    if (!kb) {
      kb = kbManager.create(WIDGET_KB_NAME);
      logger.info(`[Widget] Auto-created knowledge base: ${kb.id}`);
    }
    res.json({ kbId: kb.id, kbName: kb.name });
  });

  app.delete('/api/kb/:kbId', (req, res) => {
    const { kbId } = req.params;
    // 从内存中移除 RAG 实例
    ragInstances.delete(kbId);
    const deleted = kbManager.delete(kbId);
    if (!deleted) return res.status(404).json({ error: '知识库不存在' });
    res.json({ success: true });
  });

  // ===== 知识库提示词 =====

  app.get('/api/:kbId/prompt', (req, res) => {
    const kb = kbManager.get(req.params.kbId);
    if (!kb) return res.status(404).json({ error: '知识库不存在' });
    res.json({ systemPrompt: kb.systemPrompt || '' });
  });

  app.put('/api/:kbId/prompt', (req, res) => {
    const { kbId } = req.params;
    const { systemPrompt } = req.body;
    if (typeof systemPrompt !== 'string') return res.status(400).json({ error: '缺少 systemPrompt 参数' });
    const kb = kbManager.updateSystemPrompt(kbId, systemPrompt);
    if (!kb) return res.status(404).json({ error: '知识库不存在' });
    // 刷新内存中的 RAGService 实例
    if (ragInstances.has(kbId)) {
      ragInstances.get(kbId)!.setSystemPrompt(systemPrompt);
    }
    res.json({ success: true });
  });

  // ===== 模型状态（全局，不依赖 KB）=====

  app.get('/api/model/status', async (_req, res) => {
    try {
      const firstKb = kbManager.list()[0];
      if (!firstKb) {
        // 没有知识库时仍返回配置中的模型名，避免前端显示 unknown
        const model = config.llmProvider === 'ollama' ? (config.ollamaModel || 'llama3')
                    : config.llmProvider === 'openai' ? 'gpt-4o-mini'
                    : 'claude-sonnet-4-6-20250929';
        return res.json({ provider: config.llmProvider, model, loaded: false, loading: false });
      }
      const rag = getRagService(firstKb.id);
      res.json(await rag.getModelStatus());
    } catch (error) {
      res.status(500).json({ error: '获取模型状态失败' });
    }
  });

  app.post('/api/model/warmup', async (_req, res) => {
    try {
      const firstKb = kbManager.list()[0];
      if (!firstKb) return res.status(400).json({ error: '没有知识库' });
      const rag = getRagService(firstKb.id);
      await rag.warmUp();
      res.json({ success: true, ...(await rag.getModelStatus()) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '模型加载失败' });
    }
  });

  // ===== KB 范围路由（以下路由需要验证 KB 是否存在）=====

  app.use('/api/:kbId', (req, res, next) => {
    if (!kbManager.get(req.params.kbId)) {
      return res.status(404).json({ error: '知识库不存在' });
    }
    next();
  });

  // SSE 进度订阅（KB 范围）
  app.get('/api/:kbId/upload-progress/:fileId', (req, res) => {
    const { fileId } = req.params;
    const progressManager = ProgressManager.getInstance();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendProgress = (progress: any) => {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    };

    const currentProgress = progressManager.getProgress(fileId);
    if (currentProgress) sendProgress(currentProgress);

    const unsubscribe = progressManager.subscribe(fileId, sendProgress);
    req.on('close', () => unsubscribe());
  });

  // 健康检查
  app.get('/api/:kbId/health', async (req, res) => {
    try {
      const rag = getRagService(req.params.kbId);
      res.json(await rag.healthCheck());
    } catch (error) {
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // 统计信息
  app.get('/api/:kbId/stats', async (req, res) => {
    try {
      const rag = getRagService(req.params.kbId);
      res.json(await rag.getStats());
    } catch (error) {
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // 上传文档
  app.post('/api/:kbId/documents', (req, res, next) => {
    const upload = createUpload(req.params.kbId);
    upload.single('file')(req, res, (err) => {
      if (err) {
        const msg = err.message || '上传失败';
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件太大，最大支持 200MB' });
        return res.status(400).json({ error: msg });
      }
      next();
    });
  }, async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '没有上传文件' });

      const kbId = req.params.kbId;
      const rag = getRagService(kbId);
      const fileId = uuidv4();
      const progressManager = ProgressManager.getInstance();

      progressManager.createProgress(fileId, req.file.originalname);
      progressManager.updateStage(fileId, 'upload', { progress: 100, status: 'completed' });

      logger.info(`[${kbId}] Uploading document: ${req.file.originalname}`);

      // 先返回 fileId，让前端立即订阅 SSE 进度
      res.json({ success: true, fileId });

      // 后台处理文档
      rag.addDocument(req.file.path, fileId, req.file.originalname)
        .then((result) => {
          progressManager.updateStatus(fileId, 'completed');
          logger.info(`[${kbId}] Document processed: ${result.totalChunks} chunks`);
        })
        .catch((error) => {
          logger.error('Document processing failed:', error);
          progressManager.updateStatus(fileId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        });
    } catch (error) {
      logger.error('Document upload failed:', error);
      res.status(500).json({ error: '文档处理失败' });
    }
  });

  // 添加单个网页
  app.post('/api/:kbId/crawl-page', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: '缺少 url 参数' });

      let normalizedUrl: string;
      try {
        const u = new URL(url);
        normalizedUrl = u.href;
      } catch {
        return res.status(400).json({ error: 'URL 格式不正确' });
      }

      const kbId = req.params.kbId;
      const rag = getRagService(kbId);
      const fileId = uuidv4();
      const progressManager = ProgressManager.getInstance();

      progressManager.createProgress(fileId, normalizedUrl);
      progressManager.updateStage(fileId, 'upload', { progress: 100, status: 'completed' });

      logger.info(`[${kbId}] Adding single page: ${normalizedUrl}`);
      res.json({ success: true, fileId });

      rag.addWebDocuments(normalizedUrl, fileId, { maxPages: 1, requestDelay: 0 })
        .then((results) => {
          const totalChunks = results.reduce((sum, r) => sum + r.totalChunks, 0);
          progressManager.updateStatus(fileId, 'completed');
          logger.info(`[${kbId}] Single page added: ${totalChunks} chunks`);

          // 保存为网页类型的网站记录
          const pages: WebsitePage[] = results.map(r => ({
            url: r.documentId,
            title: r.documentId,
            chunks: r.totalChunks,
          }));
          saveWebsite(kbId, normalizedUrl, totalChunks, pages);
        })
        .catch((error) => {
          logger.error('Single page add failed:', error);
          progressManager.updateStatus(fileId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        });
    } catch (error) {
      logger.error('Crawl-page request failed:', error);
      res.status(500).json({ error: '添加网页失败' });
    }
  });

  // 爬取网站
  app.post('/api/:kbId/crawl', async (req, res) => {
    try {
      const { url, maxPages, requestDelay } = req.body;
      if (!url) return res.status(400).json({ error: '缺少 url 参数' });

      // 验证 URL 格式
      let normalizedUrl: string;
      try {
        const u = new URL(url);
        normalizedUrl = u.href.replace(/\/+$/, '');
      } catch {
        return res.status(400).json({ error: 'URL 格式不正确' });
      }

      const kbId = req.params.kbId;
      const rag = getRagService(kbId);
      const fileId = uuidv4();
      const progressManager = ProgressManager.getInstance();

      progressManager.createProgress(fileId, normalizedUrl);
      progressManager.updateStage(fileId, 'upload', { progress: 100, status: 'completed' });

      logger.info(`[${kbId}] Crawling website: ${normalizedUrl}`);

      // 先返回 fileId，让前端立即订阅 SSE 进度
      res.json({ success: true, fileId });

      // 后台处理
      rag.addWebDocuments(normalizedUrl, fileId, { maxPages: maxPages || 200, requestDelay: requestDelay || 1500 })
        .then((results) => {
          const totalChunks = results.reduce((sum, r) => sum + r.totalChunks, 0);
          progressManager.updateStatus(fileId, 'completed');
          logger.info(`[${kbId}] Website crawled: ${results.length} pages, ${totalChunks} chunks`);

          // 构建页面列表
          const pages: WebsitePage[] = results.map(r => ({
            url: r.documentId,
            title: r.documentId,
            chunks: r.totalChunks,
          }));

          // 保存网站信息到 websites.json
          saveWebsite(kbId, normalizedUrl, totalChunks, pages);
        })
        .catch((error) => {
          logger.error('Website crawling failed:', error);
          progressManager.updateStatus(fileId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        });
    } catch (error) {
      logger.error('Crawl request failed:', error);
      res.status(500).json({ error: '爬取失败' });
    }
  });

  // 列出知识库网站（包含每个网站下的页面详情）
  app.get('/api/:kbId/websites', async (_req, res) => {
    const kbId = _req.params.kbId;
    const websites = listWebsites(kbId);

    // 从向量库中补充页面的 displayName
    try {
      const rag = getRagService(kbId);
      const allDocs = await rag.listDocuments();

      for (const site of websites) {
        if (!site.pages || site.pages.length === 0) continue;
        for (const page of site.pages) {
          const doc = allDocs.find(d => d.source === page.url);
          if (doc && doc.displayName) {
            page.title = doc.displayName;
          }
        }
      }
    } catch {
      // 如果获取失败，保持原始数据
    }

    res.json({ websites });
  });

  // 删除知识库网站（仅删除记录，不删除已入库的向量）
  app.delete('/api/:kbId/websites', (req, res) => {
    const kbId = req.params.kbId;
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: '缺少 url 参数' });
    const removed = removeWebsite(kbId, url);
    if (!removed) return res.status(404).json({ error: '网站不存在' });
    res.json({ success: true });
  });

  // 列出文档（排除网页来源，网页在「知识库网站」中展示）
  app.get('/api/:kbId/documents', async (req, res) => {
    try {
      const rag = getRagService(req.params.kbId);
      const docs = await rag.listDocuments();
      const filtered = docs.filter(d => !d.source.startsWith('http://') && !d.source.startsWith('https://'));
      res.json({ documents: filtered });
    } catch (error) {
      res.status(500).json({ error: '获取文档列表失败' });
    }
  });

  // 删除文档
  app.delete('/api/:kbId/documents', async (req, res) => {
    try {
      const source = req.query.source as string;
      if (!source) return res.status(400).json({ error: '缺少 source 参数' });
      const rag = getRagService(req.params.kbId);
      await rag.removeDocument(decodeURIComponent(source));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: '删除失败' });
    }
  });

  // 流式聊天
  app.post('/api/:kbId/chat/stream', async (req, res) => {
    try {
      const { query, sessionId } = req.body;
      if (!query) return res.status(400).json({ error: '缺少 query 参数' });

      const kbId = req.params.kbId;
      const rag = getRagService(kbId);

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      logger.info(`[${kbId}] Stream chat: ${query}`);

      res.write(`data: ${JSON.stringify({ type: 'thinking', message: '正在检索相关文档...' })}\n\n`);

      let clientDisconnected = false;
      res.on('close', () => {
        clientDisconnected = true;
        logger.info(`[${kbId}] Client disconnected, stopping stream`);
      });

      const heartbeat = setInterval(() => {
        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
        }
      }, 10000);

      try {
        const stream = rag.chatStream(query, sessionId);
        for await (const event of stream) {
          if (clientDisconnected) break;

          try {
            if (event.type === 'sources') {
              res.write(`data: ${JSON.stringify({ type: 'content', content: '', sessionId: event.sessionId, sources: event.sources })}\n\n`);
            } else if (event.type === 'thinking') {
              res.write(`data: ${JSON.stringify({ type: 'thinking', message: event.message })}\n\n`);
            } else if (event.type === 'token') {
              res.write(`data: ${JSON.stringify({ type: 'content', content: event.token })}\n\n`);
            } else if (event.type === 'done') {
              res.write(`data: ${JSON.stringify({ type: 'done', sessionId: event.sessionId })}\n\n`);
            }
          } catch (writeErr) {
            clientDisconnected = true;
            break;
          }
        }
      } finally {
        clearInterval(heartbeat);
      }

      res.end();
    } catch (error) {
      logger.error('Stream chat failed:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : '问答失败' })}\n\n`);
      res.end();
    }
  });

  // 非流式聊天
  app.post('/api/:kbId/chat', async (req, res) => {
    try {
      const { query, sessionId } = req.body;
      if (!query) return res.status(400).json({ error: '缺少 query 参数' });
      const rag = getRagService(req.params.kbId);
      res.json(await rag.chat(query, sessionId));
    } catch (error) {
      logger.error('Chat failed:', error);
      res.status(500).json({ error: '问答失败' });
    }
  });

  // 简单查询
  app.post('/api/:kbId/query', async (req, res) => {
    try {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: '缺少 query 参数' });
      const rag = getRagService(req.params.kbId);
      res.json(await rag.query(query));
    } catch (error) {
      logger.error('Query failed:', error);
      res.status(500).json({ error: '查询失败' });
    }
  });

  // 会话列表
  app.get('/api/:kbId/sessions', async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.pageSize as string) || 20;
      const chatHistory = getChatHistory(req.params.kbId);
      res.json(chatHistory.getSessionsPage(page, pageSize));
    } catch (error) {
      res.status(500).json({ error: '获取会话列表失败' });
    }
  });

  // 会话详情
  app.get('/api/:kbId/sessions/:sessionId', async (req, res) => {
    try {
      const chatHistory = getChatHistory(req.params.kbId);
      const session = chatHistory.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: '会话不存在' });
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: '获取会话失败' });
    }
  });

  // 删除会话
  app.delete('/api/:kbId/sessions/:sessionId', async (req, res) => {
    try {
      const chatHistory = getChatHistory(req.params.kbId);
      if (!chatHistory.deleteSession(req.params.sessionId)) {
        return res.status(404).json({ error: '会话不存在' });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: '删除会话失败' });
    }
  });

  // 未匹配问题记录
  app.get('/api/:kbId/unanswered', (req, res) => {
    try {
      const logPath = path.resolve(config.dataDir, 'unanswered', `${req.params.kbId}.md`);
      if (!fs.existsSync(logPath)) {
        return res.json({ questions: [] });
      }
      const raw = fs.readFileSync(logPath, 'utf-8');
      const lines = raw.split('\n');
      const questions: { time: string; question: string }[] = [];
      for (const line of lines) {
        const match = line.match(/^\|\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*\|\s*(.+?)\s*\|$/);
        if (match) {
          questions.push({ time: match[1], question: match[2] });
        }
      }
      res.json({ questions });
    } catch (error) {
      logger.error('Failed to read unanswered questions:', error);
      res.status(500).json({ error: '读取未匹配问题失败' });
    }
  });

  // 未匹配问题原始 markdown
  app.get('/api/:kbId/unanswered/raw', (req, res) => {
    try {
      const logPath = path.resolve(config.dataDir, 'unanswered', `${req.params.kbId}.md`);
      if (!fs.existsSync(logPath)) {
        return res.send('<p>暂无未匹配问题记录</p>');
      }
      res.sendFile(logPath);
    } catch (error) {
      logger.error('Failed to read raw unanswered questions:', error);
      res.status(500).json({ error: '读取未匹配问题失败' });
    }
  });

  // ===== OpenAI 兼容 API =====

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [{
        id: 'rag-assistant',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'local',
      }],
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const { messages, stream, sessionId, kbId } = req.body;
      const effectiveKbId = kbId || kbManager.list()[0]?.id;
      if (!effectiveKbId) return res.status(400).json({ error: { message: '没有可用的知识库' } });

      const lastUserMsg = [...(messages || [])].reverse().find((m: any) => m.role === 'user');
      if (!lastUserMsg?.content) {
        return res.status(400).json({ error: { message: 'messages 中需要至少一条 role=user 的消息' } });
      }

      const query = lastUserMsg.content;
      const chatId = `chatcmpl-${uuidv4().replace(/-/g, '')}`;
      const created = Math.floor(Date.now() / 1000);
      const rag = getRagService(effectiveKbId);

      logger.info(`OpenAI API [${effectiveKbId}]: ${query} (stream=${!!stream})`);

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 10000);

        try {
          const ragStream = rag.chatStream(query, sessionId);
          let sources: any[] = [];
          for await (const event of ragStream) {
            if (event.type === 'sources' && event.sources) {
              sources = event.sources;
            } else if (event.type === 'token' && event.token) {
              res.write(`data: ${JSON.stringify({
                id: chatId, object: 'chat.completion.chunk', created, model: 'rag-assistant',
                choices: [{ index: 0, delta: { content: event.token }, finish_reason: null }],
              })}\n\n`);
            } else if (event.type === 'done') {
              const finalChunk: any = {
                id: chatId, object: 'chat.completion.chunk', created, model: 'rag-assistant',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              };
              if (sources.length > 0) {
                finalChunk.sources = sources.map((s: any) => ({
                  fileName: s.metadata?.displayName || s.metadata?.source?.split(/[\\/]/).pop() || '',
                  page: s.metadata?.page || s.metadata?.chunkIndex,
                  score: s.score,
                }));
                finalChunk.sessionId = event.sessionId;
              }
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
            }
          }
        } finally {
          clearInterval(heartbeat);
        }
        res.end();
      } else {
        const result = await rag.chat(query, sessionId);
        const response: any = {
          id: chatId, object: 'chat.completion', created, model: 'rag-assistant',
          choices: [{ index: 0, message: { role: 'assistant', content: result.answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        if (result.sources && result.sources.length > 0) {
          response.sources = result.sources.map((s: any) => ({
            fileName: s.metadata?.displayName || s.metadata?.source?.split(/[\\/]/).pop() || '',
            page: s.metadata?.page || s.metadata?.chunkIndex,
            score: s.score,
          }));
        }
        response.sessionId = result.sessionId;
        res.json(response);
      }
    } catch (error) {
      logger.error('OpenAI API error:', error);
      res.status(500).json({ error: { message: error instanceof Error ? error.message : '请求失败' } });
    }
  });

  // ===== 智能客服插件（允许跨域引用）=====

  app.get('/chat-widget.js', (_req, res) => {
    const filePath = path.join(webPath, 'chat-widget.js');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(filePath);
  });

  app.get('/chat-widget-demo', (_req, res) => {
    const filePath = path.join(webPath, 'chat-widget-demo.html');
    res.sendFile(filePath);
  });

  // ===== 静态文件 =====

  const webPath = path.join(__dirname, '../web');
  app.use(express.static(webPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

  app.get('*', (_req, res) => {
    const indexPath = path.join(webPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.json({ message: 'RAG Assistant API' });
    }
  });

  return new Promise((resolve, reject) => {
    const maxAttempts = 10;
    let attempt = 0;

    function tryListen(currentPort: number) {
      attempt++;
      const server = app.listen(currentPort, () => {
        if (currentPort !== port) {
          logger.info(`Port ${port} is in use, switched to port ${currentPort}`);
          console.log(`\n⚠️  端口 ${port} 已被占用，自动切换到 ${currentPort}`);
        }

        // 预热模型
        const firstKb = kbManager.list()[0];
        if (firstKb) {
          getRagService(firstKb.id).warmUp().then(() => {
            logger.info('LLM model warmed up');
          }).catch((err: Error) => {
            logger.warn('LLM warm-up failed (will retry on first request):', err.message);
          });
        }

        resolve(currentPort);
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          logger.info(`Port ${currentPort} is in use, trying ${currentPort + 1}...`);
          tryListen(currentPort + 1);
        } else {
          reject(err);
        }
      });
    }

    tryListen(port);
  });
}

export default startServer;

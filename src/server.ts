import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import { RAGService } from './rag/RAGService.js';
import { config } from './utils/config.js';
import logger from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 启动 Web 服务器
 */
export async function startServer(port: number): Promise<void> {
  const app = express();
  const rag = new RAGService();

  // 中间件
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // 文件上传配置
  const uploadDir = path.resolve(config.documentsDir);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, `${uniqueSuffix}-${file.originalname}`);
    },
  });

  const fileFilter = (_req: any, file: any, cb: any) => {
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

  const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  // API 路由

  // 健康检查
  app.get('/api/health', async (_req, res) => {
    try {
      const health = await rag.healthCheck();
      res.json(health);
    } catch (error) {
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // 统计信息
  app.get('/api/stats', async (_req, res) => {
    try {
      const stats = await rag.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // 上传文档
  app.post('/api/documents', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: '没有上传文件' });
      }

      logger.info(`Uploading document: ${req.file.originalname}`);
      const result = await rag.addDocument(req.file.path);

      res.json({
        success: true,
        document: {
          id: result.documentId,
          chunks: result.totalChunks,
          stats: result.stats,
        },
      });
    } catch (error) {
      logger.error('Document upload failed:', error);
      res.status(500).json({ error: '文档处理失败' });
    }
  });

  // 列出文档
  app.get('/api/documents', async (_req, res) => {
    try {
      const sources = await rag.listDocuments();
      res.json({ documents: sources });
    } catch (error) {
      res.status(500).json({ error: '获取文档列表失败' });
    }
  });

  // 删除文档
  app.delete('/api/documents/:source', async (req, res) => {
    try {
      const source = decodeURIComponent(req.params.source);
      await rag.removeDocument(source);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: '删除失败' });
    }
  });

  // 问答（带会话）
  app.post('/api/chat', async (req, res) => {
    try {
      const { query, sessionId } = req.body;

      if (!query) {
        return res.status(400).json({ error: '缺少 query 参数' });
      }

      const response = await rag.chat(query, sessionId);
      res.json(response);
    } catch (error) {
      logger.error('Chat failed:', error);
      res.status(500).json({ error: '问答失败' });
    }
  });

  // 简单查询（无会话）
  app.post('/api/query', async (req, res) => {
    try {
      const { query } = req.body;

      if (!query) {
        return res.status(400).json({ error: '缺少 query 参数' });
      }

      const response = await rag.query(query);
      res.json(response);
    } catch (error) {
      logger.error('Query failed:', error);
      res.status(500).json({ error: '查询失败' });
    }
  });

  // 获取会话列表
  app.get('/api/sessions', async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.pageSize as string) || 20;

      const { ChatHistoryManager } = await import('./utils/ChatHistoryManager.js');
      const chatHistory = new ChatHistoryManager();
      const result = chatHistory.getSessionsPage(page, pageSize);

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: '获取会话列表失败' });
    }
  });

  // 获取会话详情
  app.get('/api/sessions/:sessionId', async (req, res) => {
    try {
      const { ChatHistoryManager } = await import('./utils/ChatHistoryManager.js');
      const chatHistory = new ChatHistoryManager();
      const session = chatHistory.getSession(req.params.sessionId);

      if (!session) {
        return res.status(404).json({ error: '会话不存在' });
      }

      res.json(session);
    } catch (error) {
      res.status(500).json({ error: '获取会话失败' });
    }
  });

  // 删除会话
  app.delete('/api/sessions/:sessionId', async (req, res) => {
    try {
      const { ChatHistoryManager } = await import('./utils/ChatHistoryManager.js');
      const chatHistory = new ChatHistoryManager();
      const deleted = chatHistory.deleteSession(req.params.sessionId);

      if (!deleted) {
        return res.status(404).json({ error: '会话不存在' });
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: '删除会话失败' });
    }
  });

  // 静态文件服务（前端页面）
  const webPath = path.join(__dirname, '../web');
  app.use(express.static(webPath));

  // 所有其他路由返回前端页面
  app.get('*', (_req, res) => {
    const indexPath = path.join(webPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.json({ message: 'RAG Assistant API' });
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      resolve();
    });

    server.on('error', reject);
  });
}

export default startServer;

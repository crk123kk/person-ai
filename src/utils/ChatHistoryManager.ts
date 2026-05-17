import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import path from 'path';
import { config } from '../utils/config.js';
import logger from './logger.js';

/**
 * 消息接口
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  sources?: string[];
}

/**
 * 对话会话
 */
export interface ChatSession {
  id: string;
  messages: Message[];
  vectorIds: string[];  // 本轮检索过的文档 ID，避免重复检索
  createdAt: string;
  updatedAt: string;
  metadata?: {
    title?: string;
    tags?: string[];
  };
}

/**
 * 对话历史管理器
 */
export class ChatHistoryManager {
  private historyDir: string;

  constructor(historyDir?: string) {
    this.historyDir = historyDir ? path.resolve(historyDir) : path.resolve(config.chatHistoryDir);

    // 确保目录存在
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  /**
   * 创建新会话
   */
  createSession(): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: uuidv4(),
      messages: [],
      vectorIds: [],
      createdAt: now,
      updatedAt: now,
    };

    this.saveSession(session);
    logger.info(`Created new chat session: ${session.id}`);
    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): ChatSession | null {
    const filePath = this.getSessionPath(sessionId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as ChatSession;
    } catch (error) {
      logger.error(`Failed to load session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * 添加消息到会话
   */
  addMessage(sessionId: string, message: Message): ChatSession | null {
    const session = this.getSession(sessionId);

    if (!session) {
      return null;
    }

    session.messages.push(message);
    session.updatedAt = new Date().toISOString();

    this.saveSession(session);
    return session;
  }

  /**
   * 添加用户消息
   */
  addUserMessage(sessionId: string, content: string): ChatSession | null {
    return this.addMessage(sessionId, {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 添加助手消息
   */
  addAssistantMessage(
    sessionId: string,
    content: string,
    sources?: string[]
  ): ChatSession | null {
    return this.addMessage(sessionId, {
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
      sources,
    });
  }

  /**
   * 更新会话的向量 ID
   */
  updateVectorIds(sessionId: string, vectorIds: string[]): ChatSession | null {
    const session = this.getSession(sessionId);

    if (!session) {
      return null;
    }

    // 去重
    session.vectorIds = [...new Set([...session.vectorIds, ...vectorIds])];
    session.updatedAt = new Date().toISOString();

    this.saveSession(session);
    return session;
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    const filePath = this.getSessionPath(sessionId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Deleted chat session: ${sessionId}`);
      return true;
    }

    return false;
  }

  /**
   * 列出所有会话
   */
  listSessions(): { id: string; createdAt: string; updatedAt: string; messageCount: number }[] {
    const files = fs.readdirSync(this.historyDir);
    const sessions: { id: string; createdAt: string; updatedAt: string; messageCount: number }[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(this.historyDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const session = JSON.parse(content) as ChatSession;
          sessions.push({
            id: session.id,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length,
          });
        } catch (error) {
          logger.warn(`Failed to read session file ${file}:`, error);
        }
      }
    }

    // 按更新时间排序
    return sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * 获取会话列表（分页）
   */
  getSessionsPage(page: number = 1, pageSize: number = 20): {
    sessions: { id: string; createdAt: string; updatedAt: string; messageCount: number }[];
    total: number;
  } {
    const allSessions = this.listSessions();
    const start = (page - 1) * pageSize;
    const end = start + pageSize;

    return {
      sessions: allSessions.slice(start, end),
      total: allSessions.length,
    };
  }

  /**
   * 清空所有会话
   */
  clearAll(): void {
    const files = fs.readdirSync(this.historyDir);

    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(this.historyDir, file));
      }
    }

    logger.info('Cleared all chat sessions');
  }

  /**
   * 获取会话统计
   */
  getStats(): { totalSessions: number; totalMessages: number } {
    const sessions = this.listSessions();
    const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);

    return {
      totalSessions: sessions.length,
      totalMessages,
    };
  }

  /**
   * 保存会话到文件
   */
  private saveSession(session: ChatSession): void {
    const filePath = this.getSessionPath(session.id);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  /**
   * 获取会话文件路径
   */
  private getSessionPath(sessionId: string): string {
    return path.join(this.historyDir, `${sessionId}.json`);
  }

  /**
   * 获取最近的会话
   */
  getRecentSession(): ChatSession | null {
    const sessions = this.listSessions();

    if (sessions.length === 0) {
      return null;
    }

    return this.getSession(sessions[0].id);
  }
}

export default ChatHistoryManager;

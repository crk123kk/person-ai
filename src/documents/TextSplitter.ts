import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { MarkdownTextSplitter } from 'langchain/text_splitter';
import logger from '../utils/logger.js';

export interface ChunkConfig {
  chunkSize: number;
  chunkOverlap: number;
  strategy: 'recursive' | 'markdown' | 'code' | 'semantic';
}

/**
 * 文本分块器工厂
 * 根据文档类型自动选择合适的分块策略
 */
export class TextSplitterFactory {
  // 默认的块大小配置
  private static readonly DEFAULT_CONFIGS: Record<string, ChunkConfig> = {
    // 普通文本 - 中等块大小
    text: { chunkSize: 500, chunkOverlap: 50, strategy: 'recursive' as const },

    // Markdown - 按标题结构分块
    markdown: { chunkSize: 1000, chunkOverlap: 100, strategy: 'markdown' as const },

    // 代码 - 按函数/类分块
    code: { chunkSize: 800, chunkOverlap: 100, strategy: 'code' as const },

    // 论文/长文档 - 大块
    document: { chunkSize: 1500, chunkOverlap: 200, strategy: 'recursive' as const },
  };

  /**
   * 创建分块器
   */
  static create(config: ChunkConfig) {
    const { chunkSize, chunkOverlap, strategy } = config;

    logger.debug(`Creating text splitter: strategy=${strategy}, chunkSize=${chunkSize}`);

    switch (strategy) {
      case 'markdown':
        return new MarkdownTextSplitter({
          chunkSize,
          chunkOverlap,
        });

      case 'code':
        // 代码分块使用递归字符分块，但使用代码特定的分隔符
        return new RecursiveCharacterTextSplitter({
          chunkSize,
          chunkOverlap,
          separators: [
            '\nfunction ',
            '\nclass ',
            '\nconst ',
            '\nlet ',
            '\nvar ',
            '\nimport ',
            '\nexport ',
            '\n\n',
            '\n',
            ';',
            '.',
            ',',
            ' ',
            '',
          ],
        });

      case 'semantic':
        // 语义分块：尝试按句子边界分割
        return new RecursiveCharacterTextSplitter({
          chunkSize,
          chunkOverlap,
          separators: [
            '\n\n',
            '\n',
            '。',
            '.',
            '!',
            '！',
            '?',
            '？',
            ';',
            '；',
            ' ',
            '',
          ],
        });

      case 'recursive':
      default:
        // 递归字符分块（通用）
        return new RecursiveCharacterTextSplitter({
          chunkSize,
          chunkOverlap,
          separators: [
            '\n\n',
            '\n',
            '。',
            '.',
            '!',
            '！',
            '?',
            '？',
            ' ',
            '',
          ],
        });
    }
  }

  /**
   * 根据文件类型自动选择配置
   */
  static getConfigForFileType(fileType: string, metadata?: any): ChunkConfig {
    const config = this.DEFAULT_CONFIGS[fileType] || this.DEFAULT_CONFIGS.text;

    // 如果是代码，根据语言微调
    if (fileType === 'code' && metadata?.language) {
      const lang = metadata.language.toLowerCase();
      if (['python', 'py'].includes(lang)) {
        // Python 使用缩进，分块稍大
        return { ...config, chunkSize: Math.max(config.chunkSize, 1000) };
      }
    }

    return config;
  }

  /**
   * 分块文档
   */
  static async splitDocuments(
    documents: Document[],
    config: ChunkConfig
  ): Promise<Document[]> {
    const splitter = this.create(config);
    return splitter.splitDocuments(documents);
  }

  /**
   * 分块文本
   */
  static async splitText(text: string, config: ChunkConfig): Promise<string[]> {
    const splitter = this.create(config);
    return splitter.splitText(text);
  }
}

/**
 * 分块结果统计
 */
export interface ChunkStats {
  totalChunks: number;
  avgChunkSize: number;
  minChunkSize: number;
  maxChunkSize: number;
}

/**
 * 分块统计工具
 */
export class ChunkStatsCalculator {
  static calculate(chunks: Document[]): ChunkStats {
    const sizes = chunks.map(c => c.pageContent.length);
    const total = sizes.reduce((a, b) => a + b, 0);

    return {
      totalChunks: chunks.length,
      avgChunkSize: Math.round(total / chunks.length),
      minChunkSize: Math.min(...sizes),
      maxChunkSize: Math.max(...sizes),
    };
  }

  static logStats(stats: ChunkStats, source: string): void {
    logger.info(`Chunk stats for ${source}:`, {
      totalChunks: stats.totalChunks,
      avgChunkSize: stats.avgChunkSize,
      minChunkSize: stats.minChunkSize,
      maxChunkSize: stats.maxChunkSize,
    });
  }
}

export default TextSplitterFactory;

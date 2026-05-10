import * as fs from 'fs';
import path from 'path';
import { Document } from '@langchain/core/documents';
import logger from '../utils/logger.js';

// 动态导入 DOCX loader
let DocxLoader: any = null;

try {
  const community = await import('@langchain/community/document_loaders/fs/docx');
  DocxLoader = community.DocxLoader;
} catch (e) {
  logger.warn('DOCX loader not available, DOCX files will not be supported');
}

// PDF loader 使用 pdf-parse 包，逐页提取文本
async function loadPDF(filePath: string): Promise<Document[]> {
  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const pdfParse = require('pdf-parse');

    logger.info(`Parsing PDF file: ${filePath}`);
    const dataBuffer = fs.readFileSync(filePath);

    // 逐页提取文本，通过 pagerender 回调获取每页的真实内容
    const pageTexts: string[] = [];
    const renderPage = (pageData: any) => {
      const renderOptions = {
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      };
      return pageData.getTextContent(renderOptions).then((textContent: any) => {
        const items = textContent.items;
        if (!items || items.length === 0) {
          pageTexts.push('');
          return '';
        }

        // 根据文本项的位置信息智能合并，避免多余空格
        const LINE_HEIGHT_THRESHOLD = 2;
        let pageText = '';
        let lastY: number | null = null;
        let lastX: number | null = null;
        let lastWidth: number | null = null;

        for (const item of items) {
          if (!item.str || item.str.trim().length === 0) continue;

          const x = item.transform[4];
          const y = item.transform[5];
          const width = item.width || 0;

          if (lastY === null) {
            // 第一个文本项
            pageText += item.str;
          } else if (Math.abs(y - lastY) > LINE_HEIGHT_THRESHOLD) {
            // 换行
            pageText += '\n' + item.str;
          } else {
            // 同一行：根据 x 坐标间距判断是否需要加空格
            const gap = x - (lastX! + lastWidth!);
            // 字符宽度的中位数估算（中文约 12-16px，英文约 5-8px）
            const charWidth = Math.max(item.width / Math.max(item.str.length, 1), 1);
            if (gap > charWidth * 0.3) {
              // 间距超过 0.3 个字符宽度，加空格
              pageText += ' ' + item.str;
            } else {
              // 间距很小，直接拼接（PDF 提取伪影导致的假空格）
              pageText += item.str;
            }
          }

          lastY = y;
          lastX = x;
          lastWidth = width;
        }

        pageTexts.push(pageText);
        return '';
      });
    };

    await pdfParse(dataBuffer, { pagerender: renderPage });

    const documents: Document[] = [];
    for (let i = 0; i < pageTexts.length; i++) {
      const pageText = pageTexts[i];
      if (pageText.trim().length > 20) {
        documents.push({
          pageContent: pageText,
          metadata: {
            source: filePath,
            type: 'pdf',
            page: i + 1,
            total_pages: pageTexts.length,
          },
        });
      }
    }

    logger.info(`PDF loaded: ${pageTexts.length} pages, ${documents.length} non-empty`);
    return documents;
  } catch (error) {
    logger.error('Failed to load PDF:', error);
    throw new Error(`PDF load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface LoadedDocument {
  documents: Document[];
  metadata: {
    source: string;
    fileType: string;
    size: number;
    uploadTime: string;
  };
}

export class DocumentLoader {
  /**
   * 加载单个文件
   */
  static async load(filePath: string): Promise<LoadedDocument> {
    const ext = path.extname(filePath).toLowerCase();
    const stats = fs.statSync(filePath);

    logger.info(`Loading document: ${filePath} (size: ${stats.size} bytes)`);

    let documents: Document[];

    try {
      switch (ext) {
        case '.pdf':
          documents = await loadPDF(filePath);
          break;

        case '.docx':
          if (!DocxLoader) {
            throw new Error('DOCX support not available. Install mammoth package.');
          }
          documents = await new DocxLoader(filePath).load();
          break;

        case '.md':
        case '.markdown':
          documents = await this.loadMarkdown(filePath);
          break;

        case '.txt':
        case '.text':
          documents = await this.loadText(filePath);
          break;

        // 代码文件
        case '.py':
        case '.js':
        case '.ts':
        case '.jsx':
        case '.tsx':
        case '.java':
        case '.go':
        case '.rs':
        case '.cpp':
        case '.c':
        case '.h':
          documents = await this.loadCode(filePath, ext.slice(1));
          break;

        default:
          // 未知类型，尝试作为文本加载
          logger.warn(`Unknown file type: ${ext}, attempting to load as text`);
          documents = await this.loadText(filePath);
      }

      return {
        documents,
        metadata: {
          source: filePath,
          fileType: this.getFileType(ext),
          size: stats.size,
          uploadTime: new Date().toISOString(),
        },
      };
    } catch (error) {
      logger.error(`Failed to load document ${filePath}:`, error);
      throw new Error(`Failed to load ${filePath}: ${error}`);
    }
  }

  /**
   * 加载目录中的所有文档
   */
  static async loadDirectory(dirPath: string, recursive: boolean = true): Promise<LoadedDocument[]> {
    const results: LoadedDocument[] = [];
    const supportedExtensions = [
      '.pdf', '.md', '.markdown', '.txt', '.text',
      '.docx',
      '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.cpp', '.c', '.h',
    ];

    const walk = async (currentPath: string): Promise<void> => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          if (recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await walk(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (supportedExtensions.includes(ext)) {
            try {
              const loaded = await this.load(fullPath);
              results.push(loaded);
            } catch (error) {
              logger.warn(`Failed to load ${fullPath}, skipping: ${error}`);
            }
          }
        }
      }
    };

    await walk(dirPath);
    return results;
  }

  private static async loadText(filePath: string): Promise<Document[]> {
    const content = fs.readFileSync(filePath, 'utf-8');
    return [
      {
        pageContent: content,
        metadata: { source: filePath },
      },
    ];
  }

  private static async loadMarkdown(filePath: string): Promise<Document[]> {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Markdown 保留结构用于后续分块
    return [
      {
        pageContent: content,
        metadata: { source: filePath, type: 'markdown' },
      },
    ];
  }

  private static async loadCode(filePath: string, language: string): Promise<Document[]> {
    const content = fs.readFileSync(filePath, 'utf-8');
    return [
      {
        pageContent: content,
        metadata: { source: filePath, type: 'code', language },
      },
    ];
  }

  private static getFileType(ext: string): string {
    if (['.md', '.markdown'].includes(ext)) return 'markdown';
    if (['.pdf'].includes(ext)) return 'pdf';
    if (['.docx'].includes(ext)) return 'docx';
    if (['.txt', '.text'].includes(ext)) return 'text';
    if (['.py', '.js', '.ts', '.java', '.go', '.rs', '.cpp'].includes(ext)) return 'code';
    return 'text';
  }
}

export default DocumentLoader;

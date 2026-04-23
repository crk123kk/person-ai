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

// PDF loader 使用 pdf-parse 包
async function loadPDF(filePath: string): Promise<Document[]> {
  try {
    // 使用 require 方式导入，绕过 ESM 测试代码问题
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const pdfParse = require('pdf-parse');

    logger.info(`Parsing PDF file: ${filePath}`);
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);

    const pages = data.numpages;
    const text = data.text;
    const documents: Document[] = [];

    // 简单按页数平均分割
    const avgCharsPerPage = Math.floor(text.length / Math.max(pages, 1));

    for (let i = 0; i < pages; i++) {
      const startIdx = i * avgCharsPerPage;
      const endIdx = i === pages - 1 ? text.length : (i + 1) * avgCharsPerPage;
      const pageText = text.slice(startIdx, endIdx);

      if (pageText.trim().length > 50) {
        documents.push({
          pageContent: pageText,
          metadata: {
            source: filePath,
            type: 'pdf',
            page: i + 1,
            total_pages: pages,
          },
        });
      }
    }

    logger.info(`PDF loaded: ${pages} pages, ${text.length} characters`);
    return documents;
  } catch (error) {
    logger.error('Failed to load PDF:', error);
    throw new Error(`PDF load failed: ${error.message}`);
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

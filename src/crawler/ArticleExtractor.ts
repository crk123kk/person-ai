import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { Document } from '@langchain/core/documents';
import logger from '../utils/logger.js';

export interface ExtractedArticle {
  url: string;
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
}

/**
 * 文章内容提取器
 * 使用 Mozilla Readability 从网页 HTML 中提取正文
 */
export class ArticleExtractor {
  /**
   * 从 HTML 中提取文章正文
   */
  static extract(html: string, url: string): ExtractedArticle | null {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article || !article.textContent || article.textContent.trim().length < 50) {
        logger.warn(`[ArticleExtractor] No meaningful content extracted from ${url}`);
        return null;
      }

      return {
        url,
        title: article.title || url,
        content: article.content || '',
        textContent: article.textContent.trim(),
        excerpt: article.excerpt || '',
      };
    } catch (error) {
      logger.warn(`[ArticleExtractor] Failed to extract from ${url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 将提取的文章转为 LangChain Document
   */
  static toDocument(article: ExtractedArticle): Document {
    // 将 HTML 正文转为更干净的文本（保留标题层级信息）
    let cleanContent = article.textContent;

    // 如果 HTML 内容质量更好（保留了标题结构），优先使用处理后的 HTML
    if (article.content) {
      cleanContent = this.htmlToMarkdown(article.content);
    }

    return new Document({
      pageContent: cleanContent,
      metadata: {
        source: article.url,
        title: article.title,
        type: 'web',
        excerpt: article.excerpt,
      },
    });
  }

  /**
   * 简易 HTML → 文本转换（保留标题层级和段落结构）
   */
  private static htmlToMarkdown(html: string): string {
    let text = html;

    // 保留标题结构
    text = text.replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_, level, content) => {
      const prefix = '#'.repeat(parseInt(level));
      return `\n${prefix} ${this.stripTags(content).trim()}\n`;
    });

    // 段落
    text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, (_, content) => {
      return `\n${this.stripTags(content).trim()}\n`;
    });

    // 列表项
    text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');

    // 换行
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');

    // 链接：保留文本
    text = text.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');

    // 加粗/斜体
    text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '$2');
    text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '$2');

    // 代码
    text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```');

    // 移除剩余 HTML 标签
    text = this.stripTags(text);

    // 清理多余空白
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/^[ \t]+$/gm, '');

    return text.trim();
  }

  private static stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '');
  }
}

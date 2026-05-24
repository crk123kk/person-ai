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
 * 优先使用 Mozilla Readability，失败时降级为全页面文本提取
 */
export class ArticleExtractor {
  /** Readability 认为有意义的最小文本长度 */
  private static readonly MIN_READABLE_LENGTH = 50;

  /** 降级提取的最小文本长度 */
  private static readonly MIN_FALLBACK_LENGTH = 30;

  /**
   * 从 HTML 中提取文章正文
   */
  static extract(html: string, url: string): ExtractedArticle | null {
    // 策略 1: Readability
    const article = this.tryReadability(html, url);
    if (article && article.textContent.trim().length >= this.MIN_READABLE_LENGTH) {
      return article;
    }

    if (article) {
      logger.info(`[ArticleExtractor] Readability result too short (${article.textContent.trim().length} chars), trying fallback for ${url}`);
    } else {
      logger.info(`[ArticleExtractor] Readability returned null, trying fallback for ${url}`);
    }

    // 策略 2: 降级提取（适合产品页、非文章结构页面）
    const fallback = this.tryFallback(html, url);
    if (fallback && fallback.textContent.trim().length >= this.MIN_FALLBACK_LENGTH) {
      return fallback;
    }

    // 如果 Readability 有结果但很短，优先返回 Readability 的结果
    if (article) return article;
    if (fallback) return fallback;

    logger.warn(`[ArticleExtractor] No content extracted from ${url}`);
    return null;
  }

  /**
   * 使用 Mozilla Readability 提取
   */
  private static tryReadability(html: string, url: string): ExtractedArticle | null {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article || !article.textContent) return null;

      return {
        url,
        title: article.title || url,
        content: article.content || '',
        textContent: article.textContent.trim(),
        excerpt: article.excerpt || '',
      };
    } catch (error) {
      logger.warn(`[ArticleExtractor] Readability error for ${url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 降级提取：从 body 中直接提取所有可见文本
   * 适用于产品详情页、非标准文章格式的页面
   */
  private static tryFallback(html: string, url: string): ExtractedArticle | null {
    try {
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;

      // 移除无用元素
      const removeTags = ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'iframe', 'svg'];
      for (const tag of removeTags) {
        doc.querySelectorAll(tag).forEach(el => el.remove());
      }

      // 尝试找主要内容容器
      const mainSelectors = [
        'main', 'article', '[role="main"]',
        '#content', '#main', '#main-content', '.content', '.main',
        '.product-detail', '.product-info', '.detail-content',
        '.item-detail', '.goods-detail', '.offer-detail',
        '#detail', '.detail', '#description', '.description',
      ];

      let contentEl: Element | null = null;
      for (const sel of mainSelectors) {
        contentEl = doc.querySelector(sel);
        if (contentEl) break;
      }

      // 如果没找到特定容器，用 body
      const source = contentEl || doc.body;
      const text = (source.textContent || '').replace(/\s+/g, ' ').trim();

      // 获取标题
      const title = doc.querySelector('h1')?.textContent?.trim()
        || doc.querySelector('title')?.textContent?.trim()
        || url;

      // 获取描述
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';

      if (text.length < this.MIN_FALLBACK_LENGTH) return null;

      return {
        url,
        title,
        content: text,
        textContent: text,
        excerpt: metaDesc || text.slice(0, 200),
      };
    } catch (error) {
      logger.warn(`[ArticleExtractor] Fallback error for ${url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 将提取的文章转为 LangChain Document
   */
  static toDocument(article: ExtractedArticle): Document {
    let cleanContent = article.textContent;

    if (article.content && article.content !== article.textContent) {
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

  // ── HTML → Markdown ──────────────────────────────────────

  private static htmlToMarkdown(html: string): string {
    let text = html;

    text = text.replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_, level, content) => {
      const prefix = '#'.repeat(parseInt(level));
      return `\n${prefix} ${this.stripTags(content).trim()}\n`;
    });

    text = text.replace(/<p[^>]*>(.*?)<\/p>/gi, (_, content) => {
      return `\n${this.stripTags(content).trim()}\n`;
    });

    text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');
    text = text.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, '$2');
    text = text.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, '$2');
    text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```');
    text = this.stripTags(text);

    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/^[ \t]+$/gm, '');

    return text.trim();
  }

  private static stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '');
  }
}

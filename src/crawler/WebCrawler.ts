import { Document } from '@langchain/core/documents';
import { UrlDiscovery } from './UrlDiscovery.js';
import { ArticleExtractor } from './ArticleExtractor.js';
import logger from '../utils/logger.js';

export interface CrawlOptions {
  maxPages?: number;
  requestDelay?: number;
}

export interface CrawlProgress {
  phase: 'discovering' | 'crawling' | 'done' | 'failed';
  discovered?: number;
  current?: number;
  total?: number;
  currentUrl?: string;
  message: string;
}

export type CrawlProgressCallback = (progress: CrawlProgress) => void;

/**
 * 网站爬虫
 * 从一个网站 URL 出发，发现所有文章，逐篇抓取正文
 */
export class WebCrawler {
  /**
   * 爬取网站所有文章
   */
  static async crawl(
    siteUrl: string,
    options: CrawlOptions = {},
    onProgress?: CrawlProgressCallback
  ): Promise<Document[]> {
    const { maxPages = 200, requestDelay = 1500 } = options;

    // Phase 1: 发现所有文章 URL
    onProgress?.({
      phase: 'discovering',
      message: `正在发现 ${siteUrl} 的文章列表...`,
    });

    const discovery = new UrlDiscovery(siteUrl);
    const urls = await discovery.discover({ maxPages, requestDelay });

    if (urls.length === 0) {
      onProgress?.({
        phase: 'failed',
        message: `未发现任何文章。请确认网站地址正确，或该网站提供了 sitemap/RSS。`,
      });
      return [];
    }

    logger.info(`[WebCrawler] Discovered ${urls.length} URLs from ${siteUrl}`);
    onProgress?.({
      phase: 'crawling',
      discovered: urls.length,
      current: 0,
      total: urls.length,
      message: `发现 ${urls.length} 篇文章，开始抓取...`,
    });

    // Phase 2: 逐篇抓取正文
    const documents: Document[] = [];
    const errors: string[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      onProgress?.({
        phase: 'crawling',
        discovered: urls.length,
        current: i + 1,
        total: urls.length,
        currentUrl: url,
        message: `正在抓取 ${i + 1}/${urls.length}: ${url}`,
      });

      try {
        const html = await this.fetchPage(url);
        if (!html) {
          errors.push(`${url}: empty response`);
          continue;
        }

        const article = ArticleExtractor.extract(html, url);
        if (!article) {
          errors.push(`${url}: no content extracted`);
          continue;
        }

        const doc = ArticleExtractor.toDocument(article);
        documents.push(doc);

        logger.debug(`[WebCrawler] Extracted: ${article.title} (${article.textContent.length} chars)`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${url}: ${msg}`);
        logger.warn(`[WebCrawler] Failed to crawl ${url}: ${msg}`);
      }

      // 请求间隔，避免被封
      if (requestDelay > 0 && i < urls.length - 1) {
        await new Promise(r => setTimeout(r, requestDelay));
      }
    }

    logger.info(`[WebCrawler] Crawled ${documents.length}/${urls.length} articles from ${siteUrl}`);
    if (errors.length > 0) {
      logger.warn(`[WebCrawler] ${errors.length} URLs failed: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '...' : ''}`);
    }

    onProgress?.({
      phase: 'done',
      current: documents.length,
      total: urls.length,
      message: `抓取完成：成功 ${documents.length} 篇，失败 ${errors.length} 篇`,
    });

    return documents;
  }

  /**
   * 抓取单个页面
   */
  static async crawlSingle(url: string): Promise<Document | null> {
    const html = await this.fetchPage(url);
    if (!html) return null;

    const article = ArticleExtractor.extract(html, url);
    if (!article) return null;

    return ArticleExtractor.toDocument(article);
  }

  /**
   * 获取页面 HTML
   */
  private static async fetchPage(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'RAG-Crawler/1.0',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(30000),
        redirect: 'follow',
      });

      if (!resp.ok) {
        logger.warn(`[WebCrawler] HTTP ${resp.status} for ${url}`);
        return null;
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        logger.warn(`[WebCrawler] Non-HTML content type "${contentType}" for ${url}`);
        return null;
      }

      return await resp.text();
    } catch (error) {
      logger.warn(`[WebCrawler] Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

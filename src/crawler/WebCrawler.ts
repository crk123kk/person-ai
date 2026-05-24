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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

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

    // 兜底：如果未发现子文章，把输入 URL 本身当做单页内容抓取
    if (urls.length === 0) {
      logger.info(`[WebCrawler] No article URLs discovered, falling back to single-page mode for ${siteUrl}`);
      onProgress?.({
        phase: 'crawling',
        current: 0,
        total: 1,
        message: `未发现文章列表，直接将当前页面作为内容抓取...`,
      });

      let html: string | null = null;
      try {
        html = await this.fetchPage(siteUrl);
        if (html) {
          const article = ArticleExtractor.extract(html, siteUrl);
          if (article) {
            const doc = ArticleExtractor.toDocument(article);
            onProgress?.({
              phase: 'done',
              current: 1,
              total: 1,
              message: `单页抓取完成：${article.title} (${article.textContent.length} 字)`,
            });
            return [doc];
          }
        }
      } catch (err) {
        logger.warn(`[WebCrawler] Single-page fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      onProgress?.({
        phase: 'failed',
        message: html
          ? `页面已加载 (${html.length} 字符) 但未能提取有效正文，可能是反爬页面或验证码。`
          : `无法加载页面 ${siteUrl}，可能被反爬拦截或需要浏览器渲染。请确认 Chromium 已安装：npx playwright install chromium`,
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

    // 清理浏览器资源
    try {
      const { BrowserCrawler } = await import('./BrowserCrawler.js');
      await BrowserCrawler.close();
    } catch {
      // BrowserCrawler not loaded or already closed
    }

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
   * 获取页面 HTML（fetch 优先，JS 壳页面自动降级到无头浏览器）
   */
  private static async fetchPage(url: string): Promise<string | null> {
    // 先尝试普通 fetch
    const html = await this.fetchWithHTTP(url);

    // HTTP 完全失败（网络错误、403 等）→ 降级到浏览器
    if (!html) {
      logger.info(`[WebCrawler] HTTP fetch failed for ${url}, trying headless browser...`);
      try {
        const rendered = await this.fetchWithBrowser(url);
        if (rendered) return rendered;
      } catch (err) {
        logger.warn(`[WebCrawler] Browser fallback also failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }

    // HTTP 成功但返回 JS 壳 → 降级到浏览器
    if (this.isJSShell(html)) {
      logger.info(`[WebCrawler] JS shell detected for ${url}, trying headless browser...`);
      try {
        const rendered = await this.fetchWithBrowser(url);
        if (rendered) return rendered;
        logger.warn(`[WebCrawler] Browser fallback returned empty, using original HTML`);
      } catch (err) {
        logger.warn(`[WebCrawler] Browser fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return html;
  }

  /**
   * 普通 HTTP 请求获取页面
   */
  private static async fetchWithHTTP(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
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

  /**
   * 用无头浏览器获取 JS 渲染后的页面
   */
  private static async fetchWithBrowser(url: string): Promise<string | null> {
    try {
      const { BrowserCrawler } = await import('./BrowserCrawler.js');
      return await BrowserCrawler.fetchPage(url);
    } catch (error) {
      logger.warn(`[WebCrawler] Browser fetch error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 检测 HTML 是否为 JS 壳页面（SPA 空壳，需要浏览器渲染）
   */
  private static isJSShell(html: string): boolean {
    if (!html || html.length < 300) return true;

    // 提取 body 内的纯文本
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;
    const textOnly = bodyHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    // 可见文本极少 → 很可能是 SPA 壳
    if (textOnly.length < 200) return true;

    // 常见 SPA 根容器
    const spaRoots = [
      '<div id="root"',
      '<div id="app"',
      '<div id="__next"',
      '<div id="__nuxt"',
      '<app-root',
      '<div id="app-root"',
    ];

    const hasSpaRoot = spaRoots.some(p => html.includes(p));
    if (!hasSpaRoot) return false;

    // 有 SPA 根容器 + 文本少 → 确认为壳
    const scriptCount = (html.match(/<script[\s>]/gi) || []).length;
    return textOnly.length < 500 || (scriptCount > 3 && textOnly.length < 1000);
  }
}

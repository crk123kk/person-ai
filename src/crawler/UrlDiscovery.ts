import logger from '../utils/logger.js';

export interface DiscoveryOptions {
  maxPages?: number;
  requestDelay?: number;
}

/** 追踪参数（对内容无意义的广告/统计参数） */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|dclid|ref$|referrer|_ga|_gl|_hs|mc_cid|mc_eid|trk|spm|scm|aff_id|campaign_id|ad_id|wd|__|timestamp|t$|rand$)/i;

/** 排除出文章 URL 的路径关键词（出现在路径任意位置即排除） */
const NON_ARTICLE_PATH_WORDS = [
  'category', 'categories', 'tag', 'tags', 'search', 'author',
  'login', 'register', 'signin', 'signup', 'account', 'cart',
  'checkout', 'wishlist', 'order', 'orders', 'tracking',
  'faq', 'about', 'contact', 'privacy', 'terms', 'help',
];

/** 认为是列表/导航页的路径模式 */
const LIST_PAGE_PATTERNS = [
  /\/page\/\d+/i,
  /\/archives\/?/i,
  /\/category\//i,
  /\/categories\//i,
  /\/tag\//i,
  /\/tags\//i,
  /\/collections\//i,
  /\/search\//i,
  /\/shop\//i,
  /\/products\/?$/i,
  /\/catalog\//i,
  /\/list\//i,
  /\/grid\//i,
];

/** 常见内容页面模式 */
const ARTICLE_PATH_PATTERNS = [
  /\/\d{4}\/\d{2}\//,
  /\/post\//i, /\/posts\//i,
  /\/p\/\d+/i,
  /\/article\//i,
  /\/blog\//i,
  /\/news\//i,
  /\/detail\//i,
  /\/product\//i, /\/product-detail\//i,
  /\/item\//i,
  /\/goods\//i,
  /\/offer\//i,
  /\/\d+\.html?$/,
  /\/[a-z0-9-]+-detail-\d+/i,
];

/** 已知的两段式 TLD */
const TWO_PART_TLDS = ['co.uk', 'com.cn', 'com.au', 'co.jp', 'co.kr', 'com.br', 'com.tw', 'com.hk', 'co.nz', 'co.in'];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * URL 发现器
 * 从一个网站根 URL 出发，通过多种策略发现所有文章链接
 * 优先级：sitemap → RSS → 递归链接
 */
export class UrlDiscovery {
  private baseUrl: string;
  private baseDomain: string;
  private rootDomain: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    try {
      const url = new URL(this.baseUrl);
      this.baseDomain = url.hostname;
      this.rootDomain = this.extractRootDomain(this.baseDomain);
    } catch {
      throw new Error(`Invalid URL: ${baseUrl}`);
    }
  }

  /**
   * 发现所有文章 URL
   */
  async discover(options: DiscoveryOptions = {}): Promise<string[]> {
    const { maxPages = 200 } = options;

    // 策略 1: sitemap
    logger.info(`[UrlDiscovery] Trying sitemap for ${this.baseUrl}`);
    const sitemapUrls = await this.trySitemap();
    if (sitemapUrls.length > 0) {
      logger.info(`[UrlDiscovery] Found ${sitemapUrls.length} URLs from sitemap`);
      return this.dedupeAndLimit(sitemapUrls, maxPages);
    }

    // 策略 2: RSS/Atom feed
    logger.info(`[UrlDiscovery] Trying RSS/Atom for ${this.baseUrl}`);
    const rssUrls = await this.tryRSS();
    if (rssUrls.length > 0) {
      logger.info(`[UrlDiscovery] Found ${rssUrls.length} URLs from RSS`);
      return this.dedupeAndLimit(rssUrls, maxPages);
    }

    // 策略 3: 递归链接发现
    logger.info(`[UrlDiscovery] Trying recursive discovery for ${this.baseUrl}`);
    const recursiveUrls = await this.recursiveDiscover(options);
    logger.info(`[UrlDiscovery] Found ${recursiveUrls.length} URLs from recursive discovery`);
    return this.dedupeAndLimit(recursiveUrls, maxPages);
  }

  // ── 域名工具 ──────────────────────────────────────────────

  /** 提取根域名（例: so.alibaba.com → alibaba.com） */
  private extractRootDomain(hostname: string): string {
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    // 两段式 TLD
    const last2 = parts.slice(-2).join('.');
    const last3 = parts.slice(-3).join('.');
    if (TWO_PART_TLDS.some(tld => hostname.endsWith('.' + tld))) {
      return last3;
    }
    return last2;
  }

  /** 判断是否同站（允许跨子域，如 so.alibaba.com ↔ www.alibaba.com） */
  private isSameSite(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      if (hostname === this.baseDomain) return true;
      return this.extractRootDomain(hostname) === this.rootDomain;
    } catch {
      return false;
    }
  }

  // ── sitemap ──────────────────────────────────────────────

  private async trySitemap(): Promise<string[]> {
    const sitemapUrls = [
      `${this.baseUrl}/sitemap.xml`,
      `${this.baseUrl}/sitemap_index.xml`,
    ];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const urls = await this.fetchAndParseSitemap(sitemapUrl);
        if (urls.length > 0) return urls;
      } catch {
        continue;
      }
    }

    // robots.txt
    try {
      const resp = await fetch(`${this.baseUrl}/robots.txt`, {
        headers: { 'User-Agent': randomUA() },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const text = await resp.text();
        const matches = text.match(/^Sitemap:\s*(.+)$/gmi);
        if (matches) {
          for (const m of matches) {
            const sitemapUrl = m.replace(/^Sitemap:\s*/i, '').trim();
            try {
              const urls = await this.fetchAndParseSitemap(sitemapUrl);
              if (urls.length > 0) return urls;
            } catch {
              continue;
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return [];
  }

  private async fetchAndParseSitemap(sitemapUrl: string, depth: number = 0): Promise<string[]> {
    if (depth > 3) return [];
    try {
      logger.info(`[UrlDiscovery] Fetching sitemap: ${sitemapUrl}`);
      const resp = await fetch(sitemapUrl, {
        headers: { 'User-Agent': randomUA() },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return [];

      const xml = await resp.text();

      if (/<sitemap[\s>]/i.test(xml)) {
        const subUrls = this.extractSitemapIndexUrls(xml);
        logger.info(`[UrlDiscovery] Sitemap index, ${subUrls.length} sub-sitemaps`);
        const allUrls: string[] = [];
        for (const subUrl of subUrls) {
          try {
            const nested = await this.fetchAndParseSitemap(subUrl, depth + 1);
            allUrls.push(...nested);
          } catch { continue; }
        }
        return allUrls;
      }

      return this.extractPageUrls(xml);
    } catch (error) {
      logger.warn(`[UrlDiscovery] Sitemap fetch failed ${sitemapUrl}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private extractSitemapIndexUrls(xml: string): string[] {
    const urls: string[] = [];
    const re = /<sitemap[\s>][\s\S]*?<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const url = m[1].trim();
      if (url) urls.push(url);
    }
    if (urls.length === 0) {
      const simple = /<sitemap[^>]*>[\s\S]*?<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
      while ((m = simple.exec(xml)) !== null) {
        const url = m[1].trim();
        if (url) urls.push(url);
      }
    }
    return urls;
  }

  private extractPageUrls(xml: string): string[] {
    const urls: string[] = [];
    const re = /<url>[\s\S]*?<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const url = m[1].trim();
      if (this.isSameSite(url) && this.isPageUrl(url)) {
        urls.push(url);
      }
    }
    if (urls.length === 0) {
      const loose = /<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
      while ((m = loose.exec(xml)) !== null) {
        const url = m[1].trim();
        if (this.isSameSite(url) && this.isPageUrl(url)) {
          urls.push(url);
        }
      }
    }
    return [...new Set(urls)];
  }

  // ── RSS / Atom ───────────────────────────────────────────

  private async tryRSS(): Promise<string[]> {
    const feedPaths = [
      '/feed/', '/feed.xml', '/rss.xml', '/atom.xml',
      '/index.xml', '/feed/atom/', '/rss/', '/rss2/',
    ];

    for (const feedPath of feedPaths) {
      try {
        const resp = await fetch(`${this.baseUrl}${feedPath}`, {
          headers: { 'User-Agent': randomUA() },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) continue;

        const xml = await resp.text();
        const urls = this.parseFeedXml(xml);
        if (urls.length > 0) return urls;
      } catch { continue; }
    }

    // HTML <link> 中的 feed
    try {
      const resp = await fetch(this.baseUrl, {
        headers: { 'User-Agent': randomUA() },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const html = await resp.text();
        const feedMatch = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i);
        if (feedMatch) {
          const feedUrl = new URL(feedMatch[1], this.baseUrl).href;
          const feedResp = await fetch(feedUrl, {
            headers: { 'User-Agent': randomUA() },
            signal: AbortSignal.timeout(10000),
          });
          if (feedResp.ok) {
            const xml = await feedResp.text();
            const urls = this.parseFeedXml(xml);
            if (urls.length > 0) return urls;
          }
        }
      }
    } catch { /* ignore */ }

    return [];
  }

  private parseFeedXml(xml: string): string[] {
    const urls: string[] = [];
    const rssRe = /<link>\s*(?:<!\[CDATA\[)?(https?:\/\/[^\s<\]]+?)(?:\]\]>)?\s*<\/link>/gi;
    let m;
    while ((m = rssRe.exec(xml)) !== null) {
      const url = m[1].trim();
      if (this.isSameSite(url) && this.isPageUrl(url) && !url.includes('/feed') && !url.includes('/rss')) {
        urls.push(url);
      }
    }
    const atomRe = /<link[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    while ((m = atomRe.exec(xml)) !== null) {
      const url = m[1].trim();
      if (this.isSameSite(url) && this.isPageUrl(url) && !url.includes('/feed') && !url.includes('/rss')) {
        urls.push(url);
      }
    }
    return [...new Set(urls)];
  }

  // ── 递归链接发现 ──────────────────────────────────────────

  private async recursiveDiscover(options: DiscoveryOptions = {}): Promise<string[]> {
    const { requestDelay = 1500 } = options;
    const visited = new Set<string>();
    const found = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: this.baseUrl, depth: 0 }];
    const maxDepth = 2;
    let totalLinks = 0;
    let articleLinks = 0;
    let listLinks = 0;

    while (queue.length > 0 && found.size < (options.maxPages || 200)) {
      const item = queue.shift()!;

      if (visited.has(item.url) || item.depth > maxDepth) continue;
      visited.add(item.url);

      try {
        // 尝试 HTTP fetch，失败则降级到浏览器
        let html: string | null = null;
        let usedBrowser = false;

        const resp = await fetch(item.url, {
          headers: { 'User-Agent': randomUA() },
          signal: AbortSignal.timeout(15000),
        });

        if (resp.ok) {
          html = await resp.text();
        }

        // HTTP 失败或返回 JS 壳 → 用浏览器渲染
        if (!html || this.isJSShell(html)) {
          const reason = !html ? `HTTP ${resp.status}` : 'JS shell detected';
          logger.info(`[UrlDiscovery] ${reason} for ${item.url}, trying browser...`);
          try {
            html = await this.fetchWithBrowser(item.url);
            if (html) usedBrowser = true;
          } catch (err) {
            logger.warn(`[UrlDiscovery] Browser fetch also failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (!html) {
          logger.warn(`[UrlDiscovery] Failed to get HTML for ${item.url}, skipping`);
          continue;
        }

        const links = this.extractLinks(html, item.url);
        totalLinks += links.length;

        for (const link of links) {
          if (visited.has(link)) continue;

          if (this.isArticleUrl(link)) {
            found.add(link);
            articleLinks++;
          } else if (item.depth < maxDepth && this.isListPage(link)) {
            queue.push({ url: link, depth: item.depth + 1 });
            listLinks++;
          }
        }

        logger.debug(`[UrlDiscovery] depth=${item.depth} url=${item.url}: ${links.length} links, ${articleLinks} articles so far${usedBrowser ? ' (browser)' : ''}`);

        if (requestDelay > 0) {
          await new Promise(r => setTimeout(r, requestDelay));
        }
      } catch (err) {
        logger.warn(`[UrlDiscovery] Error processing ${item.url}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    logger.info(`[UrlDiscovery] recursiveDiscover done: ${visited.size} pages visited, ${totalLinks} links found, ${found.size} articles, ${listLinks} list pages queued`);
    return [...found];
  }

  // ── 链接提取 ──────────────────────────────────────────────

  private extractLinks(html: string, pageUrl: string): string[] {
    const links: string[] = [];
    const hrefRe = /href=["'](\/[^"']*|https?:\/\/[^"']+)["']/gi;
    let m;

    while ((m = hrefRe.exec(html)) !== null) {
      try {
        const absoluteUrl = new URL(m[1], pageUrl).href;
        if (!this.isSameSite(absoluteUrl)) continue;
        if (absoluteUrl === pageUrl) continue;

        const cleaned = this.cleanUrl(absoluteUrl);
        if (cleaned) links.push(cleaned);
      } catch {
        continue;
      }
    }

    return [...new Set(links)];
  }

  private async fetchWithBrowser(url: string): Promise<string | null> {
    try {
      const { BrowserCrawler } = await import('./BrowserCrawler.js');
      return await BrowserCrawler.fetchPage(url);
    } catch (error) {
      logger.warn(`[UrlDiscovery] BrowserCrawler unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private cleanUrl(url: string): string {
    try {
      const parsed = new URL(url);
      for (const key of [...parsed.searchParams.keys()]) {
        if (TRACKING_PARAMS.test(key)) {
          parsed.searchParams.delete(key);
        }
      }
      parsed.hash = '';
      return parsed.href;
    } catch {
      return url.split('#')[0];
    }
  }

  private isJSShell(html: string): boolean {
    if (!html || html.length < 300) return true;
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : html;
    const textOnly = bodyHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (textOnly.length < 200) return true;
    const spaRoots = ['<div id="root"', '<div id="app"', '<div id="__next"', '<div id="__nuxt"', '<app-root'];
    if (!spaRoots.some(p => html.includes(p))) return false;
    return textOnly.length < 500;
  }

  // ── URL 分类 ──────────────────────────────────────────────

  private isPageUrl(url: string): boolean {
    try {
      const pathname = new URL(url).pathname;
      const excludeExt = /\.(xml|json|css|js|png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|pdf|zip|gz|rss|atom)$/i;
      if (excludeExt.test(pathname)) return false;
      const excludePath = /\/feed|\/rss|\/atom|\/wp-json|\/wp-includes|\/wp-content\/(?!uploads)/i;
      if (excludePath.test(pathname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  private isArticleUrl(url: string): boolean {
    if (!this.isPageUrl(url)) return false;

    try {
      const pathname = new URL(url).pathname.toLowerCase();

      // 1. 排除列表/导航/功能页面
      for (const pat of LIST_PAGE_PATTERNS) {
        if (pat.test(pathname)) return false;
      }

      // 2. 路径片段含非文章关键词 → 排除
      const segments = pathname.split('/').filter(Boolean);
      for (const seg of segments) {
        if (NON_ARTICLE_PATH_WORDS.includes(seg)) return false;
      }

      // 3. 明确的内容页面模式
      for (const pat of ARTICLE_PATH_PATTERNS) {
        if (pat.test(pathname)) return true;
      }

      // 4. 路径深度 >= 2 且未被排除 → 可能是文章页
      if (segments.length >= 2) return true;

      return false;
    } catch {
      return false;
    }
  }

  private isListPage(url: string): boolean {
    try {
      const pathname = new URL(url).pathname;

      if (pathname === '/' || pathname === '') return true;

      for (const pat of LIST_PAGE_PATTERNS) {
        if (pat.test(pathname)) return true;
      }

      // 有分页参数
      try {
        const sp = new URL(url).searchParams;
        if (sp.has('page') || sp.has('p') || sp.has('offset') || sp.has('pn')) return true;
      } catch { /* ignore */ }

      return false;
    } catch {
      return false;
    }
  }

  // ── 工具 ──────────────────────────────────────────────────

  private dedupeAndLimit(urls: string[], maxPages: number): string[] {
    return [...new Set(urls)].slice(0, maxPages);
  }
}

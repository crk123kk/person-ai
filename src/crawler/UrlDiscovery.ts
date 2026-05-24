import logger from '../utils/logger.js';

export interface DiscoveryOptions {
  maxPages?: number;
  requestDelay?: number;
}

/**
 * URL 发现器
 * 从一个网站根 URL 出发，通过多种策略发现所有文章链接
 * 优先级：sitemap → RSS → 递归链接
 */
export class UrlDiscovery {
  private baseUrl: string;
  private baseDomain: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    try {
      const url = new URL(this.baseUrl);
      this.baseDomain = url.hostname;
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

  /**
   * 尝试从 sitemap.xml 获取 URL 列表
   */
  private async trySitemap(): Promise<string[]> {
    const sitemapUrls = [
      `${this.baseUrl}/sitemap.xml`,
      `${this.baseUrl}/sitemap_index.xml`,
      `${this.baseUrl}/sitemap/`,
    ];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const urls = await this.fetchAndParseSitemap(sitemapUrl);
        if (urls.length > 0) return urls;
      } catch {
        continue;
      }
    }

    // 尝试从 robots.txt 中找 sitemap
    try {
      const resp = await fetch(`${this.baseUrl}/robots.txt`, {
        headers: { 'User-Agent': 'RAG-Crawler/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const text = await resp.text();
        const sitemapMatches = text.match(/^Sitemap:\s*(.+)$/gmi);
        if (sitemapMatches) {
          for (const m of sitemapMatches) {
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

  /**
   * 获取并解析一个 sitemap（支持 sitemap index 递归）
   */
  private async fetchAndParseSitemap(sitemapUrl: string, depth: number = 0): Promise<string[]> {
    if (depth > 3) return []; // 防止无限递归

    try {
      logger.info(`[UrlDiscovery] Fetching sitemap: ${sitemapUrl}`);
      const resp = await fetch(sitemapUrl, {
        headers: { 'User-Agent': 'RAG-Crawler/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return [];

      const xml = await resp.text();

      // 检测是否为 sitemap index（包含 <sitemap> 子元素）
      const isSitemapIndex = /<sitemap[\s>]/i.test(xml);

      if (isSitemapIndex) {
        // sitemap index：提取子 sitemap URL，递归获取
        const subSitemapUrls = this.extractSitemapIndexUrls(xml);
        logger.info(`[UrlDiscovery] Sitemap index found, ${subSitemapUrls.length} sub-sitemaps`);

        const allUrls: string[] = [];
        for (const subUrl of subSitemapUrls) {
          try {
            const subUrls = await this.fetchAndParseSitemap(subUrl, depth + 1);
            allUrls.push(...subUrls);
          } catch {
            continue;
          }
        }
        return allUrls;
      }

      // 普通 sitemap：提取页面 URL（过滤掉非页面 URL）
      return this.extractPageUrls(xml);
    } catch (error) {
      logger.warn(`[UrlDiscovery] Failed to fetch sitemap ${sitemapUrl}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 从 sitemap index XML 中提取子 sitemap URL
   */
  private extractSitemapIndexUrls(xml: string): string[] {
    const urls: string[] = [];
    // 匹配 <sitemap> 块中的 <loc>
    const sitemapBlockRegex = /<sitemap[\s>][\s\S]*?<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
    let match;
    while ((match = sitemapBlockRegex.exec(xml)) !== null) {
      const url = match[1].trim();
      if (url) urls.push(url);
    }

    // 如果上面没匹配到，尝试简单匹配所有 <sitemap> 下的 <loc>
    if (urls.length === 0) {
      const simpleRegex = /<sitemap[^>]*>[\s\S]*?<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
      while ((match = simpleRegex.exec(xml)) !== null) {
        const url = match[1].trim();
        if (url) urls.push(url);
      }
    }

    return urls;
  }

  /**
   * 从普通 sitemap XML 中提取页面 URL（过滤非页面 URL）
   */
  private extractPageUrls(xml: string): string[] {
    const urls: string[] = [];
    const locRegex = /<url>[\s\S]*?<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      const url = match[1].trim();
      if (this.isSameDomain(url) && this.isPageUrl(url)) {
        urls.push(url);
      }
    }

    // 如果 <url> 块匹配失败，尝试宽松匹配
    if (urls.length === 0) {
      const looseRegex = /<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi;
      while ((match = looseRegex.exec(xml)) !== null) {
        const url = match[1].trim();
        if (this.isSameDomain(url) && this.isPageUrl(url)) {
          urls.push(url);
        }
      }
    }

    return [...new Set(urls)];
  }

  /**
   * 判断 URL 是否是可访问的页面（排除 xml/json/静态资源等）
   */
  private isPageUrl(url: string): boolean {
    try {
      const pathname = new URL(url).pathname;
      // 排除 sitemap、feed、静态资源等
      const excludeExtensions = /\.(xml|json|css|js|png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|pdf|zip|gz|rss|atom)$/i;
      if (excludeExtensions.test(pathname)) return false;

      const excludePaths = /\/sitemap|\/feed|\/rss|\/atom|\/wp-json|\/wp-includes|\/wp-content\/(?!uploads)/i;
      if (excludePaths.test(pathname)) return false;

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 尝试从 RSS/Atom feed 获取 URL 列表
   */
  private async tryRSS(): Promise<string[]> {
    const feedPaths = [
      '/feed/', '/feed.xml', '/rss.xml', '/atom.xml',
      '/index.xml', '/feed/atom/', '/rss/', '/rss2/',
    ];

    for (const feedPath of feedPaths) {
      try {
        const resp = await fetch(`${this.baseUrl}${feedPath}`, {
          headers: { 'User-Agent': 'RAG-Crawler/1.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) continue;

        const xml = await resp.text();
        const urls = this.parseFeedXml(xml);
        if (urls.length > 0) return urls;
      } catch {
        continue;
      }
    }

    // 尝试从 HTML 的 <link> 标签中找 feed
    try {
      const resp = await fetch(this.baseUrl, {
        headers: { 'User-Agent': 'RAG-Crawler/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const html = await resp.text();
        const feedMatch = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i);
        if (feedMatch) {
          const feedUrl = new URL(feedMatch[1], this.baseUrl).href;
          const feedResp = await fetch(feedUrl, {
            headers: { 'User-Agent': 'RAG-Crawler/1.0' },
            signal: AbortSignal.timeout(10000),
          });
          if (feedResp.ok) {
            const xml = await feedResp.text();
            const urls = this.parseFeedXml(xml);
            if (urls.length > 0) return urls;
          }
        }
      }
    } catch {
      // ignore
    }

    return [];
  }

  /**
   * 解析 RSS/Atom XML
   */
  private parseFeedXml(xml: string): string[] {
    const urls: string[] = [];

    // RSS <link>
    const rssLinkRegex = /<link>\s*(?:<!\[CDATA\[)?(https?:\/\/[^\s<\]]+?)(?:\]\]>)?\s*<\/link>/gi;
    let match;
    while ((match = rssLinkRegex.exec(xml)) !== null) {
      const url = match[1].trim();
      if (this.isSameDomain(url) && this.isPageUrl(url) && !url.includes('/feed') && !url.includes('/rss')) {
        urls.push(url);
      }
    }

    // Atom <link href="...">
    const atomLinkRegex = /<link[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    while ((match = atomLinkRegex.exec(xml)) !== null) {
      const url = match[1].trim();
      if (this.isSameDomain(url) && this.isPageUrl(url) && !url.includes('/feed') && !url.includes('/rss')) {
        urls.push(url);
      }
    }

    return [...new Set(urls)];
  }

  /**
   * 递归链接发现（兜底策略）
   */
  private async recursiveDiscover(options: DiscoveryOptions = {}): Promise<string[]> {
    const { requestDelay = 1500 } = options;
    const visited = new Set<string>();
    const found = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: this.baseUrl, depth: 0 }];
    const maxDepth = 2;

    while (queue.length > 0 && found.size < (options.maxPages || 200)) {
      const { url, depth } = queue.shift()!;

      if (visited.has(url) || depth > maxDepth) continue;
      visited.add(url);

      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'RAG-Crawler/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) continue;

        const html = await resp.text();
        const links = this.extractLinks(html, url);

        for (const link of links) {
          if (!visited.has(link) && this.isArticleUrl(link)) {
            found.add(link);
          }
          if (!visited.has(link) && depth < maxDepth && this.isListPage(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }

        if (requestDelay > 0) {
          await new Promise(r => setTimeout(r, requestDelay));
        }
      } catch {
        continue;
      }
    }

    return [...found];
  }

  /**
   * 从 HTML 中提取同域名链接
   */
  private extractLinks(html: string, pageUrl: string): string[] {
    const links: string[] = [];
    const hrefRegex = /href=["'](\/[^"']*|https?:\/\/[^"']+)["']/gi;
    let match;

    while ((match = hrefRegex.exec(html)) !== null) {
      try {
        const href = match[1];
        const absoluteUrl = new URL(href, pageUrl).href;
        if (this.isSameDomain(absoluteUrl)) {
          // 去掉锚点和查询参数
          const cleanUrl = absoluteUrl.split('#')[0].split('?')[0];
          if (cleanUrl && cleanUrl !== pageUrl) {
            links.push(cleanUrl);
          }
        }
      } catch {
        continue;
      }
    }

    return [...new Set(links)];
  }

  /**
   * 判断 URL 是否指向文章页面
   */
  private isArticleUrl(url: string): boolean {
    if (!this.isPageUrl(url)) return false;

    try {
      const pathname = new URL(url).pathname;
      // 排除明显的非文章页面
      const excludePatterns = [
        /^\/$/, /^\/page\/\d+/, /^\/tag\//, /^\/tags\//, /^\/category\//,
        /^\/categories\//, /^\/author\//, /^\/archive\//, /^\/archives\/?$/,
        /^\/search/, /^\/feed/, /^\/rss/, /^\/sitemap/,
      ];
      for (const p of excludePatterns) {
        if (p.test(pathname)) return false;
      }

      // 常见文章 URL 模式
      const articlePatterns = [
        /\/\d{4}\/\d{2}\//,           // /2024/01/post-slug
        /\/post\//, /\/posts\//,       // /post/slug
        /\/p\//, /\/article\//,        // /p/123, /article/slug
        /\/blog\//,                    // /blog/slug
        /\/\d+\.html?$/,              // /123.html
        /\/[a-z0-9-]+\/$/,            // /post-slug/ (简短路径)
      ];
      for (const p of articlePatterns) {
        if (p.test(pathname)) return true;
      }

      // 路径深度 >= 2 且不以特殊路径开头
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length >= 2) return true;

      return false;
    } catch {
      return false;
    }
  }

  /**
   * 判断 URL 是否可能是列表页
   */
  private isListPage(url: string): boolean {
    try {
      const pathname = new URL(url).pathname;
      return /\/page\/\d+/.test(pathname) ||
             /\/archives\/?/.test(pathname) ||
             pathname === '/' ||
             /^\/category\//.test(pathname) ||
             /^\/tag\//.test(pathname);
    } catch {
      return false;
    }
  }

  /**
   * 判断 URL 是否同域名
   */
  private isSameDomain(url: string): boolean {
    try {
      return new URL(url).hostname === this.baseDomain;
    } catch {
      return false;
    }
  }

  /**
   * 去重并限制数量
   */
  private dedupeAndLimit(urls: string[], maxPages: number): string[] {
    return [...new Set(urls)].slice(0, maxPages);
  }
}

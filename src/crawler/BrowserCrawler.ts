import { chromium, Browser, BrowserContext } from 'playwright';
import logger from '../utils/logger.js';

/** 已知的两段式 TLD */
const TWO_PART_TLDS = ['co.uk', 'com.cn', 'com.au', 'co.jp', 'co.kr', 'com.br', 'com.tw', 'com.hk', 'co.nz', 'co.in'];

function extractRootDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const last2 = parts.slice(-2).join('.');
  const last3 = parts.slice(-3).join('.');
  if (TWO_PART_TLDS.some(tld => hostname.endsWith('.' + tld))) {
    return last3;
  }
  return last2;
}

function isSameSite(url: string, sourceHostname: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === sourceHostname) return true;
    return extractRootDomain(hostname) === extractRootDomain(sourceHostname);
  } catch {
    return false;
  }
}

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

/**
 * 无头浏览器爬虫
 * 用 Playwright 渲染 JS 页面，解决 SPA 网站的爬取问题
 */
export class BrowserCrawler {
  private static browser: Browser | null = null;
  private static context: BrowserContext | null = null;
  private static initPromise: Promise<void> | null = null;

  private static readonly LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ];

  static async ensureInit(): Promise<void> {
    if (this.browser?.isConnected()) return;

    if (!this.initPromise) {
      this.initPromise = this.init();
    }
    await this.initPromise;
  }

  private static async init(): Promise<void> {
    logger.info('Launching headless browser...');
    this.browser = await chromium.launch({
      headless: true,
      args: this.LAUNCH_ARGS,
    });

    const vp = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    this.context = await this.browser.newContext({
      userAgent: ua,
      viewport: vp,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      // 模拟真实浏览器的特征
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });

    // 注入 stealth 脚本，隐藏自动化特征
    await this.context.addInitScript(() => {
      // 隐藏 webdriver 标记
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // 模拟 chrome 对象
      (window as any).chrome = {
        runtime: {},
        loadTimes: () => {},
        csi: () => {},
        app: {},
      };

      // 模拟 plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // 模拟 languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en'],
      });

      // 覆盖 permissions 查询
      const originalQuery = (window as any).navigator.permissions?.query;
      if (originalQuery) {
        (window as any).navigator.permissions.query = (parameters: any) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters);
      }
    });

    logger.info('Headless browser launched');
  }

  /**
   * 用无头浏览器获取 JS 渲染后的完整 HTML
   */
  static async fetchPage(url: string, waitMs: number = 3000): Promise<string> {
    await this.ensureInit();

    const page = await this.context!.newPage();
    try {
      // 屏蔽不必要的资源，加速爬取
      await page.route(/\.(png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|mp4|webm|css)$/i, route => route.abort());

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // 等待异步渲染
      await page.waitForTimeout(waitMs);

      // 滚动触发懒加载
      await page.evaluate(async () => {
        const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 3; i++) {
          window.scrollTo(0, document.body.scrollHeight * (i + 1) / 3);
          await delay(500);
        }
      });

      return await page.content();
    } finally {
      await page.close();
    }
  }

  /**
   * 从渲染后的页面提取所有同站链接（允许跨子域）
   */
  static async extractLinks(
    url: string,
    waitMs: number = 3000,
  ): Promise<string[]> {
    await this.ensureInit();

    const page = await this.context!.newPage();
    try {
      await page.route(/\.(png|jpg|jpeg|gif|svg|ico|woff|ttf|eot|mp4|webm|css)$/i, route => route.abort());

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await page.waitForTimeout(waitMs);

      // 滚动触发懒加载
      await page.evaluate(async () => {
        const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
        window.scrollTo(0, document.body.scrollHeight * 0.5);
        await delay(500);
        window.scrollTo(0, document.body.scrollHeight);
        await delay(500);
      });

      const links: string[] = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href]');
        const urls: string[] = [];
        anchors.forEach(a => {
          const href = a.getAttribute('href');
          if (href) urls.push(href);
        });
        return urls;
      });

      // 转为绝对 URL，过滤同站链接
      const sourceHostname = new URL(url).hostname;
      const absolute = new Set<string>();
      for (const link of links) {
        try {
          const abs = new URL(link, url).href;
          if (isSameSite(abs, sourceHostname)) {
            absolute.add(abs);
          }
        } catch {
          // skip invalid URLs
        }
      }

      logger.info(`[BrowserCrawler] Extracted ${links.length} raw links, ${absolute.size} same-site links from ${url}`);
      return [...absolute];
    } finally {
      await page.close();
    }
  }

  /**
   * 关闭浏览器，释放资源
   */
  static async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.initPromise = null;
    logger.info('Headless browser closed');
  }
}

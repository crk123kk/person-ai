# 博客全站爬取作为知识库 — 可行性分析

## 一、结论

**完全可行。** 输入一个博客首页 URL，自动发现并爬取该博客的**所有文章**，清洗后入库。本项目现有架构完美适配这一场景，`@langchain/community` 已内置所需工具。

---

## 二、核心问题：如何发现博客的所有文章

爬全站的关键不是"怎么抓一页"，而是"怎么找到这个博客有哪些文章"。不同博客的发现方式不同，需要多策略组合：

### 策略 1：Sitemap（最可靠，覆盖 90% 博客）

几乎所有博客系统（WordPress、Hexo、Hugo、Jekyll、Ghost 等）都会自动生成 sitemap。只需访问 `https://example.com/sitemap.xml` 就能拿到全站文章列表。

```
GET https://blog.example.com/sitemap.xml

返回：
<urlset>
  <url>
    <loc>https://blog.example.com/post/hello-world</loc>
    <lastmod>2025-01-15</lastmod>
  </url>
  <url>
    <loc>https://blog.example.com/post/another-post</loc>
    <lastmod>2025-03-20</lastmod>
  </url>
  ...
</urlset>
```

**优点**：精准、完整、零噪音、拿到 lastmod 可用于增量更新
**缺点**：极少数博客可能没有 sitemap

实现方式：`@langchain/community` 有现成的 `SitemapLoader`：
```typescript
import { SitemapLoader } from "@langchain/community/document_loaders/web/sitemap";
const loader = new SitemapLoader("https://blog.example.com");
const docs = await loader.load();
```

### 策略 2：RSS / Atom Feed（补充）

大部分博客提供 RSS feed，包含所有文章链接：
- WordPress: `/feed/` 或 `/feed.xml`
- Hexo: `/atom.xml`
- Hugo: `/index.xml`
- 通用尝试: `/rss.xml`, `/feed.xml`, `/atom.xml`, `/feed/`

```
GET https://blog.example.com/feed.xml

返回 XML 包含所有文章标题、链接、发布时间
```

**优点**：同样精准，且 RSS 是博客标配
**缺点**：部分博客可能关了 RSS，或只输出摘要

### 策略 3：递归链接发现（兜底）

如果 sitemap 和 RSS 都没找到，从首页出发递归爬取：
1. 抓取首页 HTML
2. 提取所有同域名链接
3. 过滤出文章页（按 URL 模式，如 `/post/`、`/p/`、`/archives/`、`/20xx/` 等）
4. 递归访问每个候选链接，直到没有新链接

**优点**：不需要网站配合
**缺点**：可能漏掉文章，也可能爬进无关页面。需要控制深度和范围

### 策略 4：分页 / 列表页遍历

对于文章列表页（首页、归档页、分类页），可能有分页：
```
https://blog.example.com/page/1/
https://blog.example.com/page/2/
...
```

遍历所有列表页 → 提取每页的文章链接 → 逐个抓取正文

### 推荐组合策略

```
输入博客 URL
    │
    ├── 1. 尝试 /sitemap.xml → 拿到全部文章 URL（首选）
    ├── 2. 尝试 /feed.xml, /atom.xml, /rss.xml → 补充 URL 列表
    ├── 3. 遍历列表页分页 → 提取文章链接
    └── 4. 递归链接发现（兜底）
    │
    ▼
拿到完整 URL 列表 → 去重 → 逐篇抓取正文 → 入库
```

---

## 三、正文抓取与清洗

拿到文章 URL 后，逐篇抓取并提取正文。网页的噪声主要来自导航栏、侧边栏、广告、评论区、页脚。

### 推荐方案

```bash
npm install @mozilla/readability jsdom
```

`@mozilla/readability` 是 Firefox 阅读模式引擎，专门用于从网页中提取正文，对博客文章效果极好：

```typescript
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

async function extractArticle(html: string, url: string): Promise<{
  title: string;
  content: string;    // HTML 格式正文
  textContent: string; // 纯文本正文
  excerpt: string;
}> {
  const doc = new JSDOM(html, { url });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();
  return {
    title: article.title,
    content: article.content,
    textContent: article.textContent,
    excerpt: article.excerpt,
  };
}
```

### 备选方案

| 库 | 特点 |
|---|---|
| `@extractus/article-extractor` | 纯 Node.js，不依赖 DOM，速度更快 |
| `cheerio` 自定义提取 | 灵活但需要针对特定网站写规则 |
| `@langchain/community` 的 `CheerioWebBaseLoader` | 直接产出 LangChain `Document` |

---

## 四、核心爬虫实现（伪代码）

```typescript
class BlogCrawler {
  async crawl(siteUrl: string, options: {
    maxPages?: number;      // 最大文章数，默认 100
    requestDelay?: number;  // 请求间隔 ms，默认 2000
    maxDepth?: number;      // 递归深度，默认 2
  }) {
    // 1. 发现所有文章 URL
    const urls = await this.discoverUrls(siteUrl);
    //    优先级：sitemap → RSS → 列表页遍历 → 递归

    // 2. 去重
    const uniqueUrls = this.dedupeUrls(urls);

    // 3. 检查 robots.txt
    const allowed = await this.checkRobots(siteUrl, uniqueUrls);

    // 4. 逐篇抓取 + 提取正文
    const articles = [];
    for (const url of allowed.slice(0, options.maxPages)) {
      const html = await this.fetchWithRetry(url);
      const article = await extractArticle(html, url);
      articles.push(article);
      // SSE 推送进度：{ current: i, total: N, url }
      await sleep(options.requestDelay);
    }

    // 5. 转为 LangChain Document，送入现有管线
    const docs = articles.map(a => ({
      pageContent: a.textContent,
      metadata: { source: a.url, title: a.title, type: 'web' }
    }));

    // 6. 复用现有管线：DataCleaner → TextSplitter → Embedding → VectorStore
    return docs;
  }

  private async discoverUrls(siteUrl: string): Promise<string[]> {
    // 策略 1: 尝试 sitemap
    const sitemapUrls = await this.trySitemap(siteUrl);
    if (sitemapUrls.length > 0) return sitemapUrls;

    // 策略 2: 尝试 RSS
    const rssUrls = await this.tryRSS(siteUrl);
    if (rssUrls.length > 0) return rssUrls;

    // 策略 3: 递归发现（兜底）
    return this.recursiveDiscover(siteUrl);
  }
}
```

---

## 五、特殊场景处理

### 5.1 不同博客平台的适配

| 平台 | Sitemap | RSS | 注意事项 |
|---|---|---|---|
| WordPress | `/sitemap.xml` | `/feed/` | 最常见，兼容最好 |
| Hexo | `/sitemap.xml` | `/atom.xml` | 静态生成，链接固定 |
| Hugo | `/sitemap.xml` | `/index.xml` | 同上 |
| Jekyll | 需插件 | `/feed.xml` | 同上 |
| Ghost | `/sitemap.xml` | `/rss/` | 同上 |
| Medium | 无 sitemap | 无 RSS | 需要特殊处理，按作者页获取 |
| 知乎专栏 | 无 | 无 | 需要 API 或滚动加载 |
| 微信公众号 | — | — | 完全封闭生态，无法直接爬取 |
| Notion 公开页 | 无 | 无 | 可用 Notion API |
| Substack | `/sitemap.xml` | `/feed/` | 兼容好 |
| 自建 SPA 博客 | 取决于实现 | 取决于实现 | 可能需要 Playwright |

### 5.2 JavaScript 渲染页面（SPA 博客）

如果博客是 React/Vue/Angular 渲染的（如 Medium、部分自建博客）：

```bash
npm install playwright  # 约 400MB
```

使用 `@langchain/community` 的 `PlaywrightWebBaseLoader`，或直接用 Playwright 打开页面等待渲染后再取 HTML。这是一个降级方案——先尝试普通 HTTP 请求，发现内容为空再切 Playwright。

### 5.3 中文博客常见平台

| 平台 | 可爬性 | 说明 |
|---|---|---|
| 博客园 (cnblogs) | ✅ 容易 | 有 sitemap，结构规整 |
| CSDN | ⚠️ 中等 | 有反爬，需控制频率 |
| 掘金 (juejin) | ⚠️ 中等 | SPA，需 Playwright |
| 简书 | ❌ 困难 | 强反爬 + 登录墙 |
| 知乎 | ❌ 困难 | 需登录 + 反爬严格 |
| 个人 Hexo/Hugo 博客 | ✅ 容易 | 静态页面，sitemap 完备 |
| 个人 WordPress | ✅ 容易 | sitemap + RSS 齐全 |

---

## 六、合规与爬取礼仪

```
robots.txt 检查 → 设置合理 User-Agent → 控制请求频率 → 仅个人使用
```

- **robots.txt**：抓取前检查 `Disallow`，若全网禁止则不爬（如知乎、简书）
- **User-Agent**：`BlogKB-Crawler/1.0 (personal use; contact@example.com)`
- **请求频率**：至少 1-3 秒间隔。博客是小站点，太快会打挂
- **法律边界**：个人学习研究用途不构成侵权；不可将爬取内容公开分发或商用

---

## 七、前端交互设计

在知识库管理界面新增"添加网页"入口，核心路径：

```
点击「添加网页」
  → 输入框：https://blog.example.com
  → 点击「开始爬取」
  → 后端依次执行：
     1. 探测 sitemap / RSS → 发现 N 篇文章
     2. 展示文章列表预览（用户可勾选/剔除）
     3. 逐篇抓取正文，SSE 推送进度
     4. 分块 → 嵌入 → 入库
  → 完成后可直接问答

进度展示：
  [████████░░░░░░] 45%  已抓取 18/40 篇
  当前：Understanding Rust Ownership
  URL：https://blog.example.com/posts/rust-ownership
```

---

## 八、前端需要改的地方

| 位置 | 改动 |
|---|---|
| `web/index.html` | 添加网页 Tab / 按钮 |
| `web/app.js` | 新增 `addWebSource()` 函数，复用 SSE 进度逻辑 |
| `src/server.ts` | 新增 `POST /api/kb/:kbId/crawl` 路由 |

---

## 九、后端需要改/新增的地方

### 新增文件

| 文件 | 职责 |
|---|---|
| `src/crawler/BlogCrawler.ts` | 核心爬虫：URL 发现 + 正文抓取 |
| `src/crawler/ArticleExtractor.ts` | 正文提取（封装 readability） |
| `src/crawler/UrlDiscovery.ts` | URL 发现策略（sitemap → RSS → 递归） |

### 修改文件

| 文件 | 改动 |
|---|---|
| `src/documents/DocumentLoader.ts` | 新增 `loadURL()` / `loadURLs()` 静态方法 |
| `src/documents/DataCleaner.ts` | 新增 `cleanHTML()` 方法 |
| `src/server.ts` | 新增爬取 API 路由 |
| `src/utils/UploadProgress.ts` | 扩展为通用 `TaskProgress`（复用给爬取任务） |

---

## 十、新增依赖

```bash
# 核心：正文提取
npm install @mozilla/readability jsdom

# 可选：SPA 博客渲染
npm install playwright  # 仅在需要时安装

# 可选：更强大的爬虫框架
npm install crawlee     # 如果需要更复杂的爬取逻辑
```

---

## 十一、实现步骤规划

| 步骤 | 内容 | 预估工时 |
|---|---|---|
| 1 | 创建 `BlogCrawler` + sitemap 发现 + 正文提取 | 1 天 |
| 2 | 接入现有文档管线（清洗→分块→嵌入→存储） | 0.5 天 |
| 3 | 后端 API + SSE 进度推送 | 0.5 天 |
| 4 | 前端 UI（URL 输入 + 进度条） | 1 天 |
| 5 | RSS 发现 + 递归链接发现（兜底策略） | 1 天 |
| 6 | 反爬处理（频率控制、robots.txt、重试） | 0.5 天 |
| 7 | 测试 + 边界处理 | 1 天 |
| **合计** | | **5.5 天** |

核心在步骤 1 和步骤 2，完成后就能跑通全流程。步骤 5 是增强覆盖率，步骤 6 是生产可用性。

---

## 十二、不做的事情（明确范围）

- ❌ 不做定时同步（第二期）
- ❌ 不做增量更新（第二期）
- ❌ 不做 Medium / 知乎 / 微信公众号等封闭平台（需要单独适配，二期按需）
- ❌ 不做身份认证（不支持需要登录才能看的博客）
- ❌ 不做图片/视频的抓取和 embedding

一期目标明确：**输入普通博客首页 URL → 自动发现所有文章 → 入库 → 能问答**。

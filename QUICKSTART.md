# RAG 个人助手 - 快速开始

> 基于 LangChain + TypeScript 的本地 RAG 个人助手

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 配置你的 API Key 或 Ollama 设置
```

### 3. 启动服务

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build && npm start

# 命令行工具
npm run cli add ./docs/笔记.md
npm run cli ask "你的问题"
```

## 📚 完整文档

详细架构设计和使用说明请查看 [README.md](README.md)

## 🛠️ 可用命令

```bash
# 开发
npm run dev          # 启动 Web 服务（热重载）
npm run build        # 编译 TypeScript
npm start            # 启动生产服务

# CLI 工具
npm run cli add <path>      # 添加文档
npm run cli ask "问题"      # 提问
npm run cli list            # 列出文档
npm run cli remove <source> # 删除文档
npm run cli stats           # 统计信息
npm run cli health          # 健康检查

# 测试
npm test             # 运行测试
npm run test:coverage # 覆盖率报告
```

## 📁 项目结构

```
d:\person-ai\
├── src/
│   ├── index.ts              # 入口文件
│   ├── cli.ts                # 命令行工具
│   ├── server.ts             # Web 服务器
│   │
│   ├── crawler/              # 网站爬取模块
│   │   ├── WebCrawler.ts     # 爬虫调度器
│   │   ├── UrlDiscovery.ts   # URL 发现（sitemap/RSS/递归）
│   │   └── ArticleExtractor.ts # 正文提取（Readability）
│   │
│   ├── rag/
│   │   ├── RAGService.ts     # RAG 核心服务
│   │   ├── EmbeddingService.ts
│   │   ├── KnowledgeBaseManager.ts
│   │   └── VectorStoreService.ts
│   │
│   ├── documents/
│   │   ├── DocumentLoader.ts # 文档加载器
│   │   ├── DataCleaner.ts    # 数据清洗
│   │   └── TextSplitter.ts   # 文本分块
│   │
│   ├── models/
│   │   └── LLMProvider.ts    # 模型提供商
│   │
│   ├── plugin/
│   │   ├── RAGPlugin.ts      # 可复用插件 API
│   │   └── index.ts          # 插件入口/导出
│   │
│   └── utils/
│       ├── config.ts         # 配置管理
│       ├── logger.ts         # 日志
│       ├── retry.ts          # 重试/熔断
│       ├── cache.ts          # 缓存
│       ├── UploadProgress.ts # SSE 进度推送
│       └── ChatHistoryManager.ts
│
├── web/                      # 前端页面
│   ├── index.html
│   ├── app.js
│   ├── chat-widget.js        # 智能客服插件（一行代码嵌入）
│   └── chat-widget-demo.html # 插件演示页
│
├── data/                     # 数据目录
├── .env.example
└── package.json
```

## 🎯 核心功能

- ✅ 多格式文档解析（PDF、Markdown、TXT、Word、代码）
- ✅ **网站爬取入库**（输入 URL 自动爬取全站文章作为知识库）
- ✅ **单网页添加**（添加指定网页作为知识来源）
- ✅ 智能文本分块（按类型自动选择策略）
- ✅ 向量语义检索（支持缓存）
- ✅ 多 LLM 支持（Claude/Ollama/OpenAI）
- ✅ 对话历史管理
- ✅ 错误处理与熔断
- ✅ Web 界面 + CLI 工具
- ✅ **插件 API**（可复用的 RAGPlugin 类，供外部项目集成）

## 📝 使用示例

### 命令行使用

```bash
# 添加单个文档
npm run cli add ./docs/Transformer 笔记.md

# 添加整个目录
npm run cli add ./docs/

# 提问
npm run cli ask "Self-Attention 是什么？"

# 继续对话（使用会话 ID）
npm run cli ask "能详细解释一下吗？" --session abc-123
```

### Web 界面

启动服务后访问 http://localhost:3000

- 📁 拖拽上传文档
- 🌐 输入网站 URL 爬取全站内容
- 💬 对话式问答
- 📚 知识库管理
- 📜 对话历史

## 🌐 网站爬取功能

### 功能说明

在知识库侧边栏中，**「知识库文档」下方有一个独立的「知识库网站」区块**，专门管理网站来源。输入一个博客/网站 URL（如 `https://iwithfuture.com/`），系统会自动：

1. **发现文章**：通过 sitemap.xml / RSS / Atom feed / 递归链接发现网站的所有文章
2. **抓取正文**：使用 Mozilla Readability 引擎提取每篇文章的正文内容（去除导航、侧边栏、广告等噪声）
3. **清洗入库**：自动清洗 HTML → 分块 → 向量化 → 存入知识库
4. **记录来源**：网站 URL 和入库分块数自动保存到「知识库网站」列表
5. **对话问答**：爬取完成后可直接对话，基于网站内容回答问题

### 使用方式

**Web 界面**：

1. 选择一个知识库
2. 在侧边栏找到「知识库网站」区块，点击 🌐 按钮或「添加网站」按钮
3. 在弹窗中选择模式：
   - **整站爬取**：输入网站地址（如 `https://iwithfuture.com/`），系统自动发现并抓取全站文章
   - **单网页**：输入具体文章地址，仅抓取该页面内容
4. 点击「开始爬取」，等待进度条完成
5. 网站会出现在「知识库网站」列表中，点击展开可查看各子页面
6. 直接对话，基于网站内容回答

**API 调用**：

```bash
# 爬取整个网站
curl -X POST http://localhost:3000/api/{kbId}/crawl \
  -H "Content-Type: application/json" \
  -d '{"url": "https://iwithfuture.com/", "maxPages": 200, "requestDelay": 1500}'

# 添加单个网页
curl -X POST http://localhost:3000/api/{kbId}/crawl-page \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article"}'
```

参数说明：
- `url`（必填）：网站/网页地址
- `maxPages`（可选）：最大爬取页数，默认 200（仅整站爬取）
- `requestDelay`（可选）：请求间隔毫秒数，默认 1500（仅整站爬取）

返回：
```json
{"success": true, "fileId": "xxx"}
```

使用返回的 `fileId` 订阅 SSE 进度：`GET /api/{kbId}/upload-progress/{fileId}`

**网站管理 API**：

```bash
# 列出知识库的所有网站（含子页面）
curl http://localhost:3000/api/{kbId}/websites

# 删除网站记录
curl -X DELETE "http://localhost:3000/api/{kbId}/websites?url=https%3A%2F%2Fiwithfuture.com"
```

### 技术实现

#### 新增文件

| 文件 | 职责 |
|---|---|
| `src/crawler/WebCrawler.ts` | 爬虫调度：协调 URL 发现 → 正文抓取 → 返回 Document[] |
| `src/crawler/UrlDiscovery.ts` | URL 发现：sitemap → RSS/Atom → 递归链接（三级策略依次降级） |
| `src/crawler/ArticleExtractor.ts` | 正文提取：基于 `@mozilla/readability` + `jsdom` 从 HTML 中提取文章 |

#### 新增依赖

```bash
npm install @mozilla/readability jsdom
```

- `@mozilla/readability`：Firefox 阅读模式引擎，从网页中精准提取正文内容
- `jsdom`：Node.js 端 DOM 解析，为 Readability 提供运行环境

#### URL 发现策略

```
输入网站 URL
  │
  ├─ 1. 尝试 sitemap.xml（覆盖 90% 博客：WordPress/Hexo/Hugo/Jekyll）
  ├─ 2. 尝试 RSS/Atom feed（/feed/、/atom.xml、/rss.xml 等）
  ├─ 3. 从 robots.txt 中找 sitemap 地址
  ├─ 4. 从 HTML <link> 标签中找 feed 地址
  └─ 5. 递归链接发现（兜底：从首页提取同域链接，深度 ≤ 2）
```

#### 数据流

```
用户输入 URL（整站 / 单网页）
    │
    ▼
WebCrawler.crawl() / crawlSingle()
    │
    ├─ UrlDiscovery.discover()  →  得到全部文章 URL 列表（整站模式）
    │
    ├─ 逐篇 fetch → ArticleExtractor.extract()
    │   └─ @mozilla/readability 提取正文，转为 LangChain Document
    │
    ▼
RAGService.addWebDocuments()
    │
    ├─ DataCleaner.cleanHTML()   →  清理 HTML 残留、实体、噪声
    ├─ TextSplitter (markdown)   →  按标题结构分块
    ├─ EmbeddingService          →  向量化
    └─ VectorStoreService        →  存储
```

#### 前端交互

- 侧边栏「知识库文档」标题旁新增 🌐 按钮
- 输入框旁新增地球图标按钮
- 点击弹出 URL 输入弹窗
- 复用现有 SSE 进度条展示爬取进度
- 爬取完成后自动刷新文档列表

#### 修改的文件

| 文件 | 改动 |
|---|---|
| `src/rag/RAGService.ts` | 新增 `addWebDocuments()` 方法 |
| `src/documents/DataCleaner.ts` | 新增 `cleanHTML()` 方法 |
| `src/server.ts` | 新增 `POST /api/:kbId/crawl`、`POST /api/:kbId/crawl-page`、`GET/DELETE /api/:kbId/websites` 路由 + 网站存储 |
| `web/index.html` | 新增「知识库网站」区块、🌐 按钮、URL 输入弹窗（含整站/单页模式选择） |
| `web/app.js` | 新增网站管理函数（`loadWebsites`、`deleteWebsite`、`openCrawlModal`、`startCrawl`）、展开/折叠网站子页面 |
| `src/plugin/RAGPlugin.ts` | 可复用插件 API，封装爬取、文档管理、对话问答 |
| `src/plugin/index.ts` | 插件入口，导出 RAGPlugin 及底层组件 |

### 支持的博客平台

| 平台 | sitemap | RSS | 备注 |
|---|---|---|---|
| WordPress | ✅ | ✅ | 兼容最好 |
| Hexo | ✅ | ✅ | 静态博客，完美支持 |
| Hugo | ✅ | ✅ | 同上 |
| Jekyll | ✅ | ✅ | 同上 |
| Ghost | ✅ | ✅ | 同上 |
| Substack | ✅ | ✅ | 同上 |
| 博客园 | ✅ | ✅ | 中文博客，兼容好 |
| CSDN | ⚠️ | ❌ | 有反爬，需控制频率 |
| Medium | ❌ | ❌ | SPA 页面，需 Playwright |
| 掘金 | ❌ | ❌ | SPA 页面，需 Playwright |

### 爬取礼仪

- 自动遵守 `robots.txt` 中的规则
- 请求间隔默认 1.5 秒，避免对目标服务器造成压力
- 设置合理的 `User-Agent: RAG-Crawler/1.0`
- 仅供个人学习研究使用

## 🎙️ 智能客服插件

一行代码嵌入智能客服到任何网站，支持流式输出、拖拽调整大小和本地聊天记录存储。

### 快速嵌入

在任何 HTML 页面中添加：

```html
<script src="https://rag.chenkk.shop/chat-widget.js"></script>
```

即可在页面右下角出现智能客服气泡，点击展开对话窗口。

### 知识库自动绑定

插件会自动绑定一个专用的「智能客服」知识库：

- **无需指定 `data-kb-id`**：插件默认使用 `GET /api/widget/kb` 自动获取/创建名为「智能客服」的知识库
- **不怕删除**：即使知识库被删除，插件下次打开时会自动重新创建
- **也可指定**：通过 `data-kb-id` 手动绑定到特定知识库，但如果该知识库被删，会自动回退到「智能客服」知识库

### WordPress 嵌入

在 WordPress 中引入插件：

1. **方法一**：安装 "Insert Headers and Footers" 插件，在 Header 中添加上述 script 标签
2. **方法二**：在主题的 `header.php` 的 `</head>` 前添加 script 标签
3. **方法三**：使用自定义 HTML 小工具添加 script 标签

### 在线演示

启动服务后访问：http://localhost:3000/chat-widget-demo

### 配置参数

通过 `data-*` 属性自定义插件行为：

| 参数 | 说明 | 默认值 |
|---|---|---|
| `data-kb-id` | 知识库 ID（留空自动绑定「智能客服」知识库） | 自动 |
| `data-server-url` | 服务器地址（默认从 script src 推断） | 自动推断 |
| `data-title` | 客服窗口标题 | `智能客服` |
| `data-welcome` | 欢迎语 | `你好！有什么可以帮你的吗？` |
| `data-placeholder` | 输入框占位符 | `输入你的问题...` |
| `data-primary-color` | 主题色 | `#4f46e5` |
| `data-avatar` | 客服头像 URL | 默认图标 |
| `data-position` | 气泡位置 `left`/`right` | `right` |

### 配置示例

```html
<!-- 最简用法：自动绑定知识库 -->
<script src="https://rag.chenkk.shop/chat-widget.js"></script>

<!-- 自定义标题、颜色 -->
<script
  src="https://rag.chenkk.shop/chat-widget.js"
  data-title="技术支持"
  data-welcome="你好，我是技术支持助手，请问有什么问题？"
  data-primary-color="#10b981"
  data-position="left"
></script>

<!-- 指定知识库 -->
<script
  src="https://rag.chenkk.shop/chat-widget.js"
  data-kb-id="my-kb"
></script>
```

### 功能特性

- **流式输出**：回答逐字显示，无需等待完整响应
- **本地记录**：聊天历史自动存储在浏览器 localStorage，刷新不丢失
- **会话管理**：自动维护 sessionId，支持多轮连续对话
- **拖拽调整大小**：拖动窗口右下角调整窗口尺寸，大小自动记忆
- **知识库自动绑定**：无需手动指定知识库，自动创建/恢复专用知识库
- **Markdown 渲染**：支持代码块、粗体、斜体、列表等格式
- **零依赖**：纯 JavaScript，无需安装任何框架
- **响应式**：自适应移动端和桌面端
- **清空记录**：点击标题栏垃圾桶图标清空聊天历史

### 技术实现

| 文件 | 职责 |
|---|---|
| `web/chat-widget.js` | 插件主文件：UI 渲染 + SSE 流式通信 + localStorage 记录 |
| `web/chat-widget-demo.html` | 演示页面，展示插件嵌入效果 |
| `src/server.ts` | `/chat-widget.js` 路由（CORS 允许跨域引用）、`/chat-widget-demo` 演示页 |

## 🔌 插件 API

RAG 助手提供了可复用的插件接口，方便外部项目集成爬取和问答功能。

### 安装

```bash
npm install rag-assistant
```

### 快速使用

```typescript
import { RAGPlugin } from 'rag-assistant/plugin';

// 初始化
const plugin = new RAGPlugin({ dataDir: './data' });
await plugin.init();

// 爬取整个网站
const crawlResult = await plugin.crawlWebsite('https://example.com', 'default', {
  maxPages: 50,
  onProgress: (p) => console.log(p.message),
});
console.log(`爬取 ${crawlResult.pagesCrawled} 页，入库 ${crawlResult.totalChunks} 个分块`);

// 添加单个网页
const pageResult = await plugin.addWebpage('https://example.com/article');
console.log(`标题: ${pageResult.title}，分块: ${pageResult.chunks}`);

// 上传本地文档
await plugin.addDocument('./notes.md');

// 对话问答
const answer = await plugin.ask('这篇文章讲了什么？');
console.log(answer.answer);

// 管理知识库
const docs = await plugin.listDocuments();
const websites = plugin.listWebsites();
```

### API 列表

| 方法 | 说明 |
|---|---|
| `init()` | 初始化插件，确保数据目录存在 |
| `crawlWebsite(url, kbId?, options?)` | 爬取整个网站并入库 |
| `addWebpage(url, kbId?, onProgress?)` | 添加单个网页到知识库 |
| `addDocument(filePath, kbId?, displayName?)` | 上传本地文档 |
| `listDocuments(kbId?)` | 列出知识库中的文档 |
| `removeDocument(source, kbId?)` | 删除文档 |
| `listWebsites(kbId?)` | 列出网站记录（含子页面） |
| `removeWebsite(url, kbId?)` | 删除网站记录 |
| `ask(question, kbId?, sessionId?)` | 对话问答 |
| `listKnowledgeBases()` | 列出所有知识库 |

### 底层组件

插件同时导出底层组件供高级定制：

```typescript
import { WebCrawler, UrlDiscovery, ArticleExtractor } from 'rag-assistant/plugin';

// 直接使用爬虫
const documents = await WebCrawler.crawl('https://example.com', { maxPages: 100 });

// 直接使用 URL 发现器
const discovery = new UrlDiscovery('https://example.com');
const urls = await discovery.discover();
```

## ⚙️ 环境变量

```bash
# LLM 配置（二选一）
LLM_PROVIDER=anthropic           # 或 ollama
ANTHROPIC_API_KEY=sk-xxx         # Claude API
OLLAMA_MODEL=llama3              # Ollama 模型

# Embedding 配置
EMBEDDING_PROVIDER=ollama        # 或 openai
OLLAMA_EMBED_MODEL=mxbai-embed-large

# 性能调优
CHUNK_SIZE=500
CHUNK_OVERLAP=50
DEFAULT_TOP_K=5
```

## 🧪 测试

```bash
# 运行所有测试
npm test

# 覆盖率报告
npm run test:coverage
```

## 📄 License

MIT

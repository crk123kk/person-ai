# Learn.md — 开发经验与踩坑记录

> 记录项目开发过程中遇到的问题、解决方案以及关键的技术决策，帮助后续 AI 和开发者快速了解项目的非显而易见细节。

---

## 一、本次会话问题与解决

### 1.1 .gitignore 规则过时导致运行时数据暴露

**问题**：项目从单知识库重构为多知识库后，数据目录结构从 `data/vectorstore/`、`data/documents/`、`data/chat-history/` 变为 `data/knowledge-bases/<kb-name>/vectorstore/` 等，旧的 gitignore 规则完全匹配不到新路径，导致所有用户上传的 PDF、向量数据、聊天记录都变成了 untracked 文件。

**解决**：将 `data/vectorstore/`、`data/documents/`、`data/chat-history/` 三条规则合并为 `data/`，直接忽略整个运行时数据目录。

**教训**：项目数据目录结构变化时，必须同步更新 gitignore。`data/` 下所有内容都是运行时产生的，不应提交。

### 1.2 .claude/settings.local.json 含本地权限配置

**问题**：`.claude/settings.local.json` 包含了本机特有的 Bash/PowerShell 权限白名单，被 git 追踪后 clone 到其他机器会产生冲突。

**解决**：将 `.claude/settings.local.json` 加入 gitignore，并用 `git rm --cached` 从追踪中移除（保留本地文件）。

### 1.3 前端对话列表需动态插入 UI 元素

**问题**：侧栏对话区需要在"今天"分组下方插入「添加对话」按钮，但对话列表是按时间动态分组的，静态 HTML 无法精确控制位置。

**解决**：将按钮从静态 HTML 移除，改为在 `renderConversationList()` 中动态渲染——遍历分组时在"今天"分组结束后插入按钮 HTML。无对话时也显示按钮。

**启示**：侧栏列表中的 UI 元素如果位置依赖数据状态，应该由 JS 动态渲染而非硬编码在 HTML 中。

---

## 二、架构关键细节（代码之外的知识）

### 2.1 向量存储：MemoryVectorStore，不是 ChromaDB

`README.md` 写的是 ChromaDB，但实际 `VectorStoreService.ts` 使用的是 LangChain 的 `MemoryVectorStore` + JSON 文件持久化。**永远不要尝试连接 ChromaDB**。

### 2.2 PDF 加载需要 createRequire

`pdf-parse` 是 CJS 模块，项目是 ESM（`"type": "module"`），在 `DocumentLoader.ts` 中需用 `createRequire()` 导入。修改 PDF 相关代码时不要改成 `import` 语法。

### 2.3 SSE 流式响应是模拟的

`/api/chat/stream` 实际是先完整调用 LLM 拿到回复，再逐字符通过 SSE 发送（10ms 间隔），**不是真正的 LLM streaming**。这是为了前端打字效果。如果后端不支持 streaming API，前端体验不受影响。

### 2.4 中文 token 估算差异

`ContextManager` 中中文按 ~2 chars/token 估算，英文按 ~4 chars/token。修改上下文窗口管理时必须保留这个差异。

### 2.5 前端无构建步骤

`web/` 下是原生 HTML/CSS/JS，没有框架、没有 bundler、没有 TypeScript。`marked.js` 从 CDN 加载。修改前端时不要引入构建工具。

### 2.6 DOCX 加载是可选的

`@langchain/community` 的 DocxLoader 通过动态 `import()` 加载，外层有 try/catch。加载失败时系统跳过 DOCX 支持而不崩溃。修改依赖时注意这个模块不是必需的。

### 2.7 知识库目录结构

每个知识库在 `data/knowledge-bases/<kb-id>/` 下有独立的 `vectorstore/`、`documents/`、`chat-history/` 和 `meta.json`。多知识库完全隔离，删除知识库只需 `rm -rf` 对应目录。

### 2.8 API 路由模式

所有 KB 相关 API 使用 `/:kbId/xxx` 格式（如 `/api/:kbId/chat/stream`）。`kbId` 与知识库目录名一一对应。

---

## 三、开发约定

### 3.1 文件修改范围

| 改什么 | 改哪些文件 |
|--------|-----------|
| 新增文档格式 | `DocumentLoader.ts` + `TextSplitter.ts` |
| 新增 LLM 提供商 | `LLMProvider.ts` + `config.ts` |
| 前端 UI | `web/index.html` + `web/app.js`（两个文件就是整个前端） |
| 新增 API | `src/server.ts`（所有路由都在这里） |

### 3.2 启动流程

```bash
cp .env.example .env   # 填写 ANTHROPIC_API_KEY 或配置 Ollama
npm install
npm run dev            # tsx watch 热重载，端口 3000
```

### 3.3 本项目无需外部服务

- 向量存储：本地 JSON 文件
- Embedding：默认用 Ollama 本地模型
- LLM：可用 Claude API 或本地 Ollama
- 零外部依赖即可运行（仅需配置一个 LLM）

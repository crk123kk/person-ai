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
│   ├── rag/
│   │   ├── RAGService.ts     # RAG 核心服务
│   │   ├── EmbeddingService.ts
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
│   └── utils/
│       ├── config.ts         # 配置管理
│       ├── logger.ts         # 日志
│       ├── retry.ts          # 重试/熔断
│       ├── cache.ts          # 缓存
│       └── ChatHistoryManager.ts
│
├── web/                      # 前端页面
│   ├── index.html
│   └── app.js
│
├── data/                     # 数据目录
├── .env.example
└── package.json
```

## 🎯 核心功能

- ✅ 多格式文档解析（PDF、Markdown、TXT、Word、代码）
- ✅ 智能文本分块（按类型自动选择策略）
- ✅ 向量语义检索（支持缓存）
- ✅ 多 LLM 支持（Claude/Ollama/OpenAI）
- ✅ 对话历史管理
- ✅ 错误处理与熔断
- ✅ Web 界面 + CLI 工具

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
- 💬 对话式问答
- 📚 知识库管理
- 📜 对话历史

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

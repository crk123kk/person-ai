# AI_README — Project Context for AI Agents

> This document is written specifically for AI coding assistants. It provides a machine-readable overview of the project's purpose, architecture, data flows, and conventions so that an AI agent can quickly orient itself when working on this codebase.

---

## 1. Project Identity

- **Name**: person-ai
- **Type**: RAG (Retrieval-Augmented Generation) Personal Knowledge Assistant
- **Primary Language**: Chinese (UI, prompts, responses all default to Chinese)
- **Status**: Working prototype with web UI and CLI

**What it does**: Users upload documents (PDF, Markdown, TXT, DOCX, code files) into a local knowledge base. When they ask questions, the system retrieves relevant document chunks via vector similarity search and uses an LLM to generate grounded answers. If no relevant documents are found, it falls back to a generic LLM response.

---

## 2. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Language | TypeScript 5.0+ (ESM) | `"type": "module"` in package.json |
| Backend | Express 4.18 | REST API + SSE streaming |
| AI Framework | LangChain.js 0.2 | Core, Anthropic, Ollama, OpenAI, Community, TextSplitters |
| LLM | Anthropic Claude (default) / Ollama / OpenAI | Failover via LLMRouter |
| Embedding | Ollama `mxbai-embed-large` (default) / OpenAI `text-embedding-3-small` | Batched with retry |
| Vector Store | LangChain `MemoryVectorStore` + JSON file persistence | NOT ChromaDB despite what README.md claims |
| Frontend | Vanilla HTML/CSS/JS | No framework, uses `marked.js` for Markdown rendering |
| File Upload | Multer | 50MB limit, file type whitelist |
| PDF Parsing | `pdf-parse` | Per-page splitting, uses `createRequire` for ESM compat |
| DOCX Parsing | `@langchain/community` DocxLoader | Dynamic import with fallback — optional |
| Logging | Winston 3.11 | File + console transports |
| Testing | Vitest | Unit tests only, in `src/__tests__/unit/` |
| Dev Runtime | `tsx watch` | Hot reload |
| Build | `tsc` → `dist/` | |

---

## 3. Architecture Overview

```
User Query
    │
    ▼
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Express  │───▶│  RAGService   │───▶│  VectorStore  │───▶│  Embedding    │───▶│  LLMProvider  │
│  Server   │    │  (orchestrator)│    │  Service      │    │  Service      │    │  (LLMRouter)  │
└──────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
     │                │
     │                ▼
     │         ┌──────────────┐
     │         │  Document     │
     │         │  Pipeline:    │
     │         │  Load→Clean→  │
     │         │  Split→Embed→ │
     │         │  Store        │
     │         └──────────────┘
     │
     ▼
┌──────────┐
│  Web UI   │  (vanilla JS, SSE streaming, marked.js)
└──────────┘
```

**Two main flows**:

1. **Document Ingestion**: Upload → Load (by file type) → Clean (DataCleaner) → Split (TextSplitter by strategy) → Embed (batched) → Store (MemoryVectorStore + JSON)
2. **Query/Chat**: User question → Embed query → Vector similarity search → Build prompt with context + history → LLM generate → Stream or return response

---

## 4. Directory Map with Purpose

```
src/
├── index.ts                  # Entry point — starts Express server
├── cli.ts                    # CLI tool (add, ask, list, remove, stats, health)
├── server.ts                 # ALL API routes and Express setup
│
├── rag/
│   ├── RAGService.ts         # Core orchestrator — ingestion pipeline + query/chat logic
│   ├── EmbeddingService.ts   # Text vectorization with batching and retry
│   └── VectorStoreService.ts # MemoryVectorStore + JSON persistence
│
├── documents/
│   ├── DocumentLoader.ts     # Multi-format loader (PDF, DOCX, MD, TXT, code)
│   ├── DataCleaner.ts        # Whitespace, PDF artifacts, PII filtering (PII not called by default)
│   └── TextSplitter.ts       # Chunking strategies: recursive, markdown, code, semantic
│
├── models/
│   └── LLMProvider.ts        # Factory + LLMRouter (primary → failover chain)
│
├── utils/
│   ├── config.ts             # Centralized config from .env with validation
│   ├── logger.ts             # Winston logger
│   ├── retry.ts              # Exponential backoff + CircuitBreaker (CLOSED/OPEN/HALF_OPEN)
│   ├── cache.ts              # QueryCache + ContextManager (sliding/summary/map-reduce)
│   ├── ChatHistoryManager.ts # Per-session JSON file persistence
│   └── UploadProgress.ts     # SSE progress tracker (singleton, 6 processing stages)
│
└── __tests__/unit/           # Vitest unit tests (cache, DataCleaner, retry)

web/
├── index.html                # Frontend SPA (full CSS embedded)
└── app.js                    # Frontend JS (vanilla, no build step)

data/                         # Runtime data (gitignored)
├── chat-history/             # JSON files per session
├── documents/                # Uploaded original files
├── logs/                     # Winston log files
└── vectorstore/
    └── memory-store.json     # Persisted vector embeddings
```

---

## 5. API Endpoints

All routes are defined in `src/server.ts`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check (embedding, vector store, LLM status) |
| GET | `/api/stats` | Document count, chunk count, session count, cache size |
| POST | `/api/documents` | Upload document (multipart, max 50MB) |
| GET | `/api/documents` | List all document sources |
| DELETE | `/api/documents/:source` | Delete document and its vectors |
| POST | `/api/chat` | Chat with session (returns JSON) |
| POST | `/api/chat/stream` | Chat with SSE streaming |
| POST | `/api/query` | One-off query without session |
| GET | `/api/sessions` | List chat sessions (paginated) |
| GET | `/api/sessions/:sessionId` | Get session details |
| DELETE | `/api/sessions/:sessionId` | Delete a session |
| GET | `/api/upload-progress/:fileId` | SSE upload progress stream |

---

## 6. Key Design Decisions & Gotchas

### Vector Store: MemoryVectorStore, NOT ChromaDB
`README.md` describes ChromaDB but the actual implementation in `VectorStoreService.ts` uses LangChain's `MemoryVectorStore` with local JSON file persistence (`data/vectorstore/memory-store.json`). This avoids the need for a ChromaDB server. **When modifying vector store code, work with MemoryVectorStore, not ChromaDB.**

### PDF Loading Uses createRequire
`pdf-parse` is a CJS module. `DocumentLoader.ts` uses `createRequire()` to import it in the ESM context. Changes to PDF loading must preserve this pattern.

### DOCX Support Is Optional
DOCX loading uses a dynamic `import()` with try/catch fallback. If `@langchain/community` DocxLoader fails to load, the system gracefully skips DOCX support rather than crashing.

### SSE Streaming Simulates Typing
`/api/chat/stream` sends the full LLM response character-by-character via SSE with a 10ms delay between characters to simulate typing. This is NOT a true streaming implementation — the full response is generated first, then dribbled out.

### Chinese Token Estimation
`ContextManager` in `cache.ts` estimates tokens differently for Chinese (~2 chars/token) vs English (~4 chars/token). This affects context window management and must be preserved.

### PII Filtering Exists But Is Inactive
`DataCleaner.filterPII()` can redact emails, phone numbers, ID cards, API keys, and IP addresses, but it is **not called in the default ingestion pipeline**. It is available as a utility if needed.

### System Prompt Enforces Chinese Output
`RAGService.buildPrompt()` instructs the LLM to prioritize retrieved content, refuse injection attempts, and respond in Chinese by default.

### Frontend Has No Build Step
The web UI is vanilla HTML/CSS/JS loaded directly by Express. `marked.js` is loaded from CDN. There is no bundler, no framework, no TypeScript on the frontend.

---

## 7. Configuration Reference

All config is in `src/utils/config.ts`, loaded from `.env`. Key variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER` | `anthropic` | LLM provider: anthropic / ollama / openai |
| `ANTHROPIC_API_KEY` | (required for anthropic) | Claude API key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `llama3` | Ollama chat model |
| `EMBEDDING_PROVIDER` | `ollama` | Embedding provider: ollama / openai |
| `OLLAMA_EMBED_MODEL` | `mxbai-embed-large` | Ollama embedding model |
| `CHUNK_SIZE` | `500` | Characters per chunk |
| `CHUNK_OVERLAP` | `50` | Overlap between chunks |
| `DEFAULT_TOP_K` | `5` | Number of retrieval results |
| `SIMILARITY_THRESHOLD` | `0.5` | Minimum similarity score |
| `LLM_TEMPERATURE` | `0.7` | LLM sampling temperature |
| `LLM_MAX_TOKENS` | `2048` | Max LLM output tokens |
| `LLM_TIMEOUT` | `60000` | LLM request timeout (ms) |
| `PORT` | `3000` | Server port |
| `QUERY_CACHE_TTL` | `3600000` | Cache TTL (1 hour) |
| `CONTEXT_STRATEGY` | `sliding` | Context overflow strategy: sliding / summary / map-reduce |

---

## 8. CLI Commands

Defined in `src/cli.ts`:

| Command | Description |
|---------|-------------|
| `add <file>` | Upload a document to the knowledge base |
| `ask <question>` or `chat <question>` | Interactive chat with session |
| `query <question>` | One-off query without session |
| `list` | List all document sources |
| `remove <source>` or `delete <source>` | Delete a document |
| `stats` | Show system statistics |
| `health` | Health check |

---

## 9. Data Flows

### Document Ingestion Pipeline (RAGService.addDocument)

```
File Upload
    │
    ▼
DocumentLoader.load()       → Parse by file type → LangChain Document[]
    │
    ▼
DataCleaner.clean()         → Format-specific cleanup (whitespace, artifacts)
    │
    ▼
TextSplitterFactory.split() → Chunking by file type strategy
    │                            - PDF/code: recursive
    │                            - Markdown: markdown-aware
    │                            - Generic: recursive with overlap
    │
    ▼
EmbeddingService.embed()    → Batch vectorization with retry
    │
    ▼
VectorStoreService.add()    → MemoryVectorStore + persist to JSON
```

### Query/Chat Flow (RAGService.chat / RAGService.query)

```
User Question
    │
    ▼
Embed question via EmbeddingService
    │
    ▼
VectorStoreService.similaritySearch()  → Top-K chunks above threshold
    │
    ▼
If results found:
    Build prompt with context + chat history → LLM generate → Return answer
If no results:
    Build prompt without context → LLM generate generic answer → Return
```

### LLM Failover Flow (LLMRouter)

```
Primary provider (default: anthropic)
    │ fail
    ▼
Secondary providers (default: ollama)
    │ fail
    ▼
CircuitBreaker opens after 5 failures → 5-minute cooldown → half-open retry
```

---

## 10. Testing

- **Framework**: Vitest
- **Location**: `src/__tests__/unit/`
- **Existing tests**: `cache.test.ts`, `DataCleaner.test.ts`, `retry.test.ts`
- **Run command**: `npm test`
- **Path alias**: `@/` maps to `src/` (configured in both `tsconfig.json` and `vitest.config.ts`)

---

## 11. Common Tasks for AI Agents

| Task | Key Files to Modify |
|------|-------------------|
| Add a new document format | `src/documents/DocumentLoader.ts` (add loader), `src/documents/TextSplitter.ts` (add strategy), `src/server.ts` (add file extension to whitelist) |
| Add a new LLM provider | `src/models/LLMProvider.ts` (add to factory + router), `src/utils/config.ts` (add config vars) |
| Modify RAG retrieval logic | `src/rag/RAGService.ts` (query/chat methods), `src/rag/VectorStoreService.ts` |
| Change chunking behavior | `src/documents/TextSplitter.ts`, `src/utils/config.ts` (CHUNK_SIZE, CHUNK_OVERLAP) |
| Add API endpoint | `src/server.ts` (all routes are here) |
| Modify frontend UI | `web/index.html` (HTML + CSS), `web/app.js` (JS logic) |
| Add context management strategy | `src/utils/cache.ts` (ContextManager) |
| Change prompt engineering | `src/rag/RAGService.ts` (buildPrompt method) |
| Add upload progress stage | `src/utils/UploadProgress.ts` (stages array), `src/rag/RAGService.ts` (emit progress) |

---

## 12. Known Discrepancies

- **README.md vs actual code**: README describes ChromaDB; actual implementation uses MemoryVectorStore with JSON persistence. Trust the code, not the README.
- **SSE streaming is simulated**: Not true LLM streaming — full response is generated, then sent character-by-character with 10ms delays.
- **PII filtering is dormant**: `DataCleaner.filterPII()` exists but is not wired into the ingestion pipeline by default.

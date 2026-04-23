import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  // LLM 配置
  llmProvider: 'anthropic' | 'ollama' | 'openai';
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  openaiApiKey?: string;

  // Embedding 配置
  embeddingProvider: 'ollama' | 'openai';
  ollamaEmbedModel?: string;
  embeddingApiKey?: string;

  // 分块配置
  chunkSize: number;
  chunkOverlap: number;

  // Embedding 配置
  embeddingBatchSize: number;
  embeddingMaxRetries: number;

  // 检索配置
  defaultTopK: number;
  similarityThreshold: number;
  retrievalMode: 'vector' | 'hybrid' | 'filtered';

  // LLM 配置
  llmTemperature: number;
  llmMaxTokens: number;
  llmTimeout: number;

  // 存储配置
  dataDir: string;
  vectorstoreDir: string;
  documentsDir: string;
  chatHistoryDir: string;

  // 服务配置
  port: number;

  // 缓存配置
  queryCacheTtl: number;
  contextStrategy: 'sliding' | 'summary' | 'map-reduce';
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseFloatNum(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const config: Config = {
  // LLM 配置
  llmProvider: (process.env.LLM_PROVIDER as any) || 'anthropic',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3',

  // Embedding 配置
  embeddingProvider: (process.env.EMBEDDING_PROVIDER as any) || 'ollama',
  ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL || 'mxbai-embed-large',
  embeddingApiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY,

  // 分块配置
  chunkSize: parseNumber(process.env.CHUNK_SIZE, 500),
  chunkOverlap: parseNumber(process.env.CHUNK_OVERLAP, 50),

  // Embedding 配置
  embeddingBatchSize: parseNumber(process.env.EMBEDDING_BATCH_SIZE, 32),
  embeddingMaxRetries: parseNumber(process.env.EMBEDDING_MAX_RETRIES, 3),

  // 检索配置
  defaultTopK: parseNumber(process.env.DEFAULT_TOP_K, 5),
  similarityThreshold: parseFloatNum(process.env.SIMILARITY_THRESHOLD, 0.5),
  retrievalMode: (process.env.RETRIEVAL_MODE as any) || 'vector',

  // LLM 配置
  llmTemperature: parseFloatNum(process.env.LLM_TEMPERATURE, 0.7),
  llmMaxTokens: parseNumber(process.env.LLM_MAX_TOKENS, 2048),
  llmTimeout: parseNumber(process.env.LLM_TIMEOUT, 60000),

  // 存储配置
  dataDir: process.env.DATA_DIR || './data',
  vectorstoreDir: process.env.VECTORSTORE_DIR || './data/vectorstore',
  documentsDir: process.env.DOCUMENTS_DIR || './data/documents',
  chatHistoryDir: process.env.CHAT_HISTORY_DIR || './data/chat-history',

  // 服务配置
  port: parseNumber(process.env.PORT, 3000),

  // 缓存配置
  queryCacheTtl: parseNumber(process.env.QUERY_CACHE_TTL, 3600000),
  contextStrategy: (process.env.CONTEXT_STRATEGY as any) || 'sliding',
};

// 验证必要配置
export function validateConfig(): void {
  const errors: string[] = [];

  if (config.llmProvider === 'anthropic' && !config.anthropicApiKey) {
    errors.push('ANTHROPIC_API_KEY is required when using Claude API');
  }

  if (config.embeddingProvider === 'openai' && !config.embeddingApiKey) {
    errors.push('OPENAI_API_KEY or EMBEDDING_API_KEY is required when using OpenAI Embedding');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.join('\n')}`);
  }
}

export default config;

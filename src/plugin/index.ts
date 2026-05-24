/**
 * RAG Plugin 入口
 *
 * 外部项目可通过以下方式引入：
 * ```ts
 * import { RAGPlugin } from 'rag-assistant/plugin';
 * // 或
 * import { RAGPlugin } from 'rag-assistant/dist/plugin/index.js';
 * ```
 */

export { RAGPlugin } from './RAGPlugin.js';
export type {
  PluginConfig,
  CrawlWebsiteOptions,
  CrawlWebsiteResult,
  WebpageResult,
  DocumentInfo,
  KnowledgeBaseInfo,
} from './RAGPlugin.js';

// 也导出底层组件供高级使用
export { WebCrawler } from '../crawler/WebCrawler.js';
export type { CrawlOptions, CrawlProgress, CrawlProgressCallback } from '../crawler/WebCrawler.js';
export { UrlDiscovery } from '../crawler/UrlDiscovery.js';
export { ArticleExtractor } from '../crawler/ArticleExtractor.js';

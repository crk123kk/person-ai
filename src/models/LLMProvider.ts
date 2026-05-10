import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';

export type StreamChunk = {
  content: string;
  done: boolean;
};

/**
 * LLM 提供商类型
 */
export type LLMProviderType = 'anthropic' | 'ollama' | 'openai';

/**
 * LLM 配置
 */
export interface LLMConfig {
  provider: LLMProviderType;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  modelName?: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 直接调用 Ollama HTTP API（绕过 LangChain，支持关闭 thinking 模式）
 */
async function* ollamaStream(prompt: string): AsyncGenerator<StreamChunk, void, undefined> {
  const baseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  const model = config.ollamaModel || 'llama3';

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      think: false,
      options: {
        temperature: config.llmTemperature,
        num_predict: config.llmMaxTokens,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.done) continue;
        // 只取 content，忽略 thinking 字段
        const content = data.message?.content || '';
        if (content) {
          yield { content, done: false };
        }
      } catch {
        // 忽略解析错误
      }
    }
  }

  yield { content: '', done: true };
}

/**
 * Ollama 非流式调用
 */
async function ollamaInvoke(prompt: string): Promise<string> {
  const baseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  const model = config.ollamaModel || 'llama3';

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      think: false,
      options: {
        temperature: config.llmTemperature,
        num_predict: config.llmMaxTokens,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { message: { content: string } };
  return data.message?.content || '';
}

/**
 * LLM 提供商工厂
 * 创建和配置不同的 LLM 提供商
 */
export class LLMProviderFactory {
  /**
   * 创建 LLM 实例
   */
  static create(configOverride?: Partial<LLMConfig>): BaseChatModel {
    const cfg: LLMConfig = {
      provider: config.llmProvider,
      temperature: config.llmTemperature,
      maxTokens: config.llmMaxTokens,
      timeout: config.llmTimeout,
      ...configOverride,
    };

    logger.info(`Creating LLM with provider: ${cfg.provider}`);

    switch (cfg.provider) {
      case 'ollama':
        return this.createOllama(cfg);

      case 'openai':
        return this.createOpenAI(cfg);

      case 'anthropic':
      default:
        return this.createAnthropic(cfg);
    }
  }

  private static createAnthropic(cfg: LLMConfig): ChatAnthropic {
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }

    return new ChatAnthropic({
      apiKey: config.anthropicApiKey,
      model: 'claude-sonnet-4-6-20250929',
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
    });
  }

  private static createOllama(cfg: LLMConfig): ChatOllama {
    return new ChatOllama({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel || 'llama3',
      temperature: cfg.temperature,
      numPredict: cfg.maxTokens,
    });
  }

  private static createOpenAI(cfg: LLMConfig): ChatOpenAI {
    if (!config.embeddingApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    return new ChatOpenAI({
      apiKey: config.embeddingApiKey,
      model: 'gpt-4o-mini',
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
    });
  }

  /**
   * 健康检查
   */
  static async healthCheck(provider?: LLMProviderType): Promise<boolean> {
    try {
      if (provider === 'ollama' || (!provider && config.llmProvider === 'ollama')) {
        await ollamaInvoke('Hi');
      } else {
        const llm = this.create(provider ? { provider } : undefined);
        await llm.invoke('Hi');
      }
      return true;
    } catch (error) {
      logger.error('LLM health check failed:', error);
      return false;
    }
  }
}

/**
 * 带降级策略的 LLM 路由
 */
export class LLMRouter {
  private primaryProvider: LLMProviderType;
  private fallbackProviders: LLMProviderType[];
  private currentProvider: LLMProviderType;

  constructor(
    primaryProvider: LLMProviderType = 'anthropic',
    fallbackProviders: LLMProviderType[] = ['ollama']
  ) {
    this.primaryProvider = primaryProvider;
    this.fallbackProviders = fallbackProviders;
    this.currentProvider = primaryProvider;
  }

  /**
   * 获取当前 LLM 实例
   */
  getLLM(): BaseChatModel {
    return LLMProviderFactory.create({ provider: this.currentProvider });
  }

  /**
   * 获取当前提供商
   */
  getCurrentProvider(): LLMProviderType {
    return this.currentProvider;
  }

  /**
   * 带降级的调用
   */
  async invoke(prompt: string): Promise<string> {
    const providersToTry = [this.currentProvider, ...this.fallbackProviders];

    for (const provider of providersToTry) {
      try {
        logger.info(`Invoking LLM provider: ${provider}`);

        if (provider === 'ollama') {
          const result = await ollamaInvoke(prompt);
          this.currentProvider = provider;
          return result;
        }

        const llm = LLMProviderFactory.create({ provider });
        const response = await llm.invoke(prompt);
        this.currentProvider = provider;
        return response.content as string;
      } catch (error) {
        logger.warn(`LLM provider ${provider} failed:`, error);
        continue;
      }
    }

    throw new Error('All LLM providers failed');
  }

  /**
   * 流式调用 LLM，逐 token 返回
   */
  async *stream(prompt: string): AsyncGenerator<StreamChunk, void, undefined> {
    const providersToTry = [this.currentProvider, ...this.fallbackProviders];

    for (const provider of providersToTry) {
      try {
        logger.info(`Streaming with LLM provider: ${provider}`);

        if (provider === 'ollama') {
          // 直接用 Ollama HTTP API，绕过 LangChain（解决 qwen thinking 模式问题）
          for await (const chunk of ollamaStream(prompt)) {
            yield chunk;
          }
          this.currentProvider = provider;
          return;
        }

        // Anthropic / OpenAI 走 LangChain
        const llm = LLMProviderFactory.create({ provider });

        const streamInitPromise = llm.stream(prompt);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Stream init timeout for ${provider} (${config.llmTimeout}ms)`)), config.llmTimeout)
        );
        const stream = await Promise.race([streamInitPromise, timeoutPromise]);

        for await (const chunk of stream) {
          const content = typeof chunk.content === 'string' ? chunk.content : '';
          if (content) {
            yield { content, done: false };
          }
        }

        this.currentProvider = provider;
        yield { content: '', done: true };
        return;
      } catch (error) {
        logger.warn(`LLM stream provider ${provider} failed:`, error);
        continue;
      }
    }

    throw new Error('All LLM providers failed for streaming');
  }

  /**
   * 重置为主提供商
   */
  reset(): void {
    this.currentProvider = this.primaryProvider;
  }
}

export default LLMProviderFactory;

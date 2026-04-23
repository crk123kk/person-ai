import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { config } from '../utils/config.js';
import logger from '../utils/logger.js';

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
      const llm = this.create(provider ? { provider } : undefined);

      // 简单测试，不消耗太多 token
      await llm.invoke('Hi');
      return true;
    } catch (error) {
      logger.error('LLM health check failed:', error);
      return false;
    }
  }
}

/**
 * 带降级策略的 LLM 路由
 * 当主 LLM 不可用时，自动切换到备用 LLM
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
        logger.debug(`Trying LLM provider: ${provider}`);
        const llm = LLMProviderFactory.create({ provider });
        const response = await llm.invoke(prompt);
        this.currentProvider = provider; // 更新当前成功 provider
        return response.content as string;
      } catch (error) {
        logger.warn(`LLM provider ${provider} failed:`, error);
        continue;
      }
    }

    throw new Error('All LLM providers failed');
  }

  /**
   * 重置为主提供商
   */
  reset(): void {
    this.currentProvider = this.primaryProvider;
  }
}

export default LLMProviderFactory;

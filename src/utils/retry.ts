import logger from '../utils/logger.js';

/**
 * 重试配置
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  exponential: boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  exponential: true,
};

/**
 * 熔断器状态
 */
export enum CircuitState {
  CLOSED = 'CLOSED',     // 正常状态
  OPEN = 'OPEN',         // 熔断状态
  HALF_OPEN = 'HALF_OPEN', // 半开状态（试探）
}

/**
 * 熔断器配置
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;    // 失败阈值
  successThreshold: number;    // 成功阈值（半开状态）
  timeout: number;              // 熔断超时（ms）
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 300000, // 5 分钟
};

/**
 * 重试工具
 * 支持指数退避
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const { maxRetries, baseDelay, maxDelay, exponential } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        logger.error(`Operation failed after ${maxRetries} retries:`, error);
        break;
      }

      // 计算延迟
      let delay: number;
      if (exponential) {
        delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      } else {
        delay = baseDelay;
      }

      // 添加抖动（0.8-1.2 倍随机）
      delay = delay * (0.8 + Math.random() * 0.4);

      logger.warn(
        `Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms:`,
        error
      );

      await sleep(delay);
    }
  }

  throw lastError!;
}

/**
 * 熔断器
 * 防止级联故障
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  /**
   * 执行受保护的操作
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.checkState();

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * 检查状态
   */
  private async checkState(): Promise<void> {
    if (this.state === CircuitState.OPEN) {
      // 检查是否可以进入半开状态
      if (Date.now() - (this.lastFailureTime || 0) >= this.config.timeout) {
        logger.info('Circuit breaker entering HALF_OPEN state');
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
  }

  /**
   * 成功回调
   */
  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        logger.info('Circuit breaker returning to CLOSED state');
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
      }
    }
  }

  /**
   * 失败回调
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      logger.warn('Circuit breaker returning to OPEN state');
      this.state = CircuitState.OPEN;
    } else if (this.failureCount >= this.config.failureThreshold) {
      logger.warn('Circuit breaker tripped to OPEN state');
      this.state = CircuitState.OPEN;
    }
  }

  /**
   * 获取当前状态
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * 手动重置
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
  }
}

/**
 * 超时包装器
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  errorMessage?: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default { retryWithBackoff, CircuitBreaker, withTimeout };

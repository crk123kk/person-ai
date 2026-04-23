import { describe, it, expect } from 'vitest';
import { retryWithBackoff, CircuitBreaker, CircuitState, withTimeout } from '../../utils/retry.js';

describe('retryWithBackoff', () => {
  it('成功时应该立即返回', async () => {
    const result = await retryWithBackoff(async () => 'success');
    expect(result).toBe('success');
  });

  it('失败时应该重试', async () => {
    let attempts = 0;

    await expect(
      retryWithBackoff(async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'success';
      }, { maxRetries: 3 })
    ).resolves.toBe('success');

    expect(attempts).toBe(3);
  });

  it('超过最大重试次数后应该抛出错误', async () => {
    let attempts = 0;

    await expect(
      retryWithBackoff(async () => {
        attempts++;
        throw new Error('always fail');
      }, { maxRetries: 2 })
    ).rejects.toThrow('always fail');

    expect(attempts).toBe(3); // 初始 + 2 次重试
  });
});

describe('CircuitBreaker', () => {
  it('初始状态应该是 CLOSED', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('达到失败阈值后应该进入 OPEN 状态', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, timeout: 1000 });

    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => { throw new Error('fail'); });
      } catch {
        // 预期失败
      }
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it('OPEN 状态下应该拒绝执行', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, timeout: 10000 });

    try {
      await breaker.execute(async () => { throw new Error('fail'); });
    } catch {
      // 预期失败
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    await expect(
      breaker.execute(async () => 'success')
    ).rejects.toThrow('Circuit breaker is OPEN');
  });

  it('超时后应该进入 HALF_OPEN 状态', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      timeout: 50,
      successThreshold: 1,
    });

    try {
      await breaker.execute(async () => { throw new Error('fail'); });
    } catch {
      // 预期失败
    }

    // 等待超时
    await new Promise(resolve => setTimeout(resolve, 100));

    // 调用 execute 触发状态检查（HALF_OPEN 状态只在 checkState 时设置）
    breaker.execute(async () => 'test').catch(() => {});

    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it('HALF_OPEN 成功后应该回到 CLOSED 状态', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 1,
      timeout: 50,
    });

    // 触发熔断
    try {
      await breaker.execute(async () => { throw new Error('fail'); });
    } catch {
      // 预期失败
    }

    // 等待超时
    await new Promise(resolve => setTimeout(resolve, 100));

    // 成功执行
    await breaker.execute(async () => 'success');

    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('可以手动重置', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      timeout: 10000,
    });

    // 需要等待 execute 完成
    try {
      await breaker.execute(async () => { throw new Error('fail'); });
    } catch {
      // 预期失败
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    breaker.reset();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });
});

describe('withTimeout', () => {
  it('在超时内完成应该返回结果', async () => {
    const result = await withTimeout(
      async () => 'success',
      1000
    );

    expect(result).toBe('success');
  });

  it('超时时应该抛出错误', async () => {
    await expect(
      withTimeout(
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return 'too late';
        },
        50
      )
    ).rejects.toThrow('Operation timed out after 50ms');
  });

  it('自定义错误消息', async () => {
    await expect(
      withTimeout(
        async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return 'too late';
        },
        50,
        'Custom timeout message'
      )
    ).rejects.toThrow('Custom timeout message');
  });
});

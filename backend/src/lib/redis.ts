/**
 * Redis 连接与辅助能力
 * 定位：限流、幂等加速、短期锁——**不保存不可重建的资金真相**。
 * 未配置 REDIS_URL 时整体降级（内存兜底），不影响服务启动。
 */

import Redis, { type Redis as RedisClient } from 'ioredis';
import { config } from './config';
import { logger } from './logger';

let client: RedisClient | null = null;

export function getClient(): RedisClient | null {
  if (client !== null) return client;
  if (!config.REDIS_URL) {
    logger.warn('REDIS_URL 未配置，Redis 能力降级为内存模式（仅限开发/测试）');
    client = null;
    return null;
  }
  const created = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  created.on('error', (err) => {
    logger.warn({ err: { message: err.message } }, 'redis error');
  });
  created.connect().catch((err) => {
    logger.warn({ err: { message: (err as Error).message } }, 'redis connect failed');
  });
  client = created;
  return client;
}

export function isRedisReady(): boolean {
  const c = getClient();
  return c !== null && c.status === 'ready';
}

export async function redisPing(): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    const pong = await c.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function redisQuit(): Promise<void> {
  const c = client;
  client = null;
  if (c) {
    try {
      await c.quit();
    } catch {
      c.disconnect();
    }
  }
}

/** 幂等键：仅作加速，真相以数据库唯一约束为准 */
export const idempotency = {
  async set(key: string, ttl = 3600): Promise<boolean> {
    const c = getClient();
    if (!c) return true; // 无 Redis 时不做拦截，由 DB 唯一约束保证
    try {
      return (await c.set(`idempotent:${key}`, '1', 'EX', ttl, 'NX')) === 'OK';
    } catch {
      return true;
    }
  },
  async check(key: string): Promise<boolean> {
    const c = getClient();
    if (!c) return false;
    try {
      return (await c.exists(`idempotent:${key}`)) === 1;
    } catch {
      return false;
    }
  },
  async delete(key: string): Promise<void> {
    const c = getClient();
    if (!c) return;
    try {
      await c.del(`idempotent:${key}`);
    } catch {
      /* ignore */
    }
  },
};

export default { getClient, isRedisReady, redisPing, redisQuit, idempotency };

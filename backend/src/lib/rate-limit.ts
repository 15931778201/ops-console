/**
 * 分级限流
 * - Redis（INCR+EXPIRE）为共享计数；未配置时退化为进程内内存计数（仅开发/单机）
 * - 登录/验证码/支付创建等敏感端点使用独立规则
 */

import type { RequestHandler } from 'express';
import { RateLimitError } from './errors';
import { getClient } from './redis';

interface Rule {
  /** 窗口内最大请求数 */
  max: number;
  /** 窗口秒数 */
  windowSec: number;
}

const memoryCounters = new Map<string, { count: number; resetAt: number }>();

function memoryCheck(key: string, rule: Rule): boolean {
  const now = Date.now();
  const entry = memoryCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    memoryCounters.set(key, { count: 1, resetAt: now + rule.windowSec * 1000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= rule.max;
}

async function redisCheck(key: string, rule: Rule): Promise<boolean> {
  const c = getClient();
  if (!c) return memoryCheck(key, rule);
  try {
    const current = await c.incr(key);
    if (current === 1) {
      await c.expire(key, rule.windowSec);
    }
    return current <= rule.max;
  } catch {
    // Redis 故障时降级内存计数，避免限流形同虚设
    return memoryCheck(key, rule);
  }
}

/** 生成限流中间件；keyFn 决定计数维度（如 IP、IP+账号） */
export function rateLimiter(
  name: string,
  rule: Rule,
  keyFn: (req: Parameters<RequestHandler>[0]) => string
): RequestHandler {
  return (req, res, next) => {
    const key = `ratelimit:${name}:${keyFn(req)}`;
    redisCheck(key, rule)
      .then((allowed) => {
        if (!allowed) {
          next(new RateLimitError());
          return;
        }
        next();
      })
      .catch(next);
  };
}

export const RATE_RULES = {
  /** 全局：每 IP 每分钟 120 次 */
  global: { max: 120, windowSec: 60 },
  /** 登录：每 IP 每分钟 10 次 */
  login: { max: 10, windowSec: 60 },
  /** 注册：每 IP 每小时 10 次 */
  register: { max: 10, windowSec: 3600 },
  /** 验证码发送：每目标 60 秒 1 条、每小时 5 条 */
  verificationSend: { max: 5, windowSec: 3600 },
  /** 创建订单/支付：每用户每分钟 6 次 */
  paymentCreate: { max: 6, windowSec: 60 },
  /** 密码找回：每 IP 每小时 5 次 */
  passwordReset: { max: 5, windowSec: 3600 },
  /** 运营后台登录（密码步）：同用户名 15 分钟 5 次 */
  adminLogin: { max: 5, windowSec: 900 },
  /** 运营后台登录：同 IP 15 分钟 20 次（覆盖 TOTP 步） */
  adminLoginIp: { max: 20, windowSec: 900 },
  /** 运营后台 TOTP 绑定/确认：同 IP 每分钟 10 次 */
  adminTotp: { max: 10, windowSec: 60 },
  /** 运营后台刷新：同 IP 每分钟 30 次 */
  adminRefresh: { max: 30, windowSec: 60 },
  /** 审计日志导出：同管理员 10 分钟 3 次（导出是敏感操作，严控） */
  auditExport: { max: 3, windowSec: 600 },
} as const;

export function clientIp(req: Parameters<RequestHandler>[0]): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * 重置计数（登录成功后调用，避免把正常用户锁在限流外）。
 * Redis 删除共享计数；无 Redis 时清理本进程内存计数。
 */
export async function resetRateLimit(name: string, key: string): Promise<void> {
  const fullKey = `ratelimit:${name}:${key}`;
  const c = getClient();
  if (!c) {
    memoryCounters.delete(fullKey);
    return;
  }
  try {
    await c.del(fullKey);
  } catch {
    memoryCounters.delete(fullKey);
  }
}

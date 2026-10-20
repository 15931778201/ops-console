/**
 * 会话服务
 * - Refresh Token：DB 存储 hash，30 天，每次刷新轮换
 * - 重放检测：已轮换的旧 token 再次使用 → 吊销该用户全部会话并告警
 * - 登出：当前会话 / 全部会话；改密后全部吊销
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Session } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../lib/config';
import { generateRefreshToken, signAccessToken } from '../lib/jwt';
import { logger } from '../lib/logger';
import { audit } from '../lib/audit';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + parseDuration(config.JWT_REFRESH_EXPIRES_IN));
}

/** 解析 '30d' / '15m' / '3600' 等时长为毫秒 */
export function parseDuration(value: string): number {
  const m = value.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] ?? 's').toLowerCase();
  const factor: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * (factor[unit] ?? 1000);
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const sessionService = {
  /** 创建会话并签发令牌对 */
  async createSession(
    userId: string,
    plan: string,
    deviceInfo?: Record<string, unknown>
  ): Promise<TokenPair> {
    const refreshToken = generateRefreshToken() + randomBytes(16).toString('hex');
    const session = await prisma.session.create({
      data: {
        userId,
        refreshTokenHash: hashToken(refreshToken),
        deviceInfo: deviceInfo as object | undefined,
        expiresAt: refreshExpiry(),
      },
    });
    return {
      accessToken: signAccessToken({ sub: userId, sid: session.id, plan }),
      refreshToken,
      expiresIn: Math.floor(parseDuration(config.JWT_ACCESS_EXPIRES_IN) / 1000),
    };
  },

  /**
   * 轮换刷新：校验 → 签发新对 → 旧会话标记 replacedBy
   * 返回 null 表示令牌无效/过期/已吊销
   * reason=REUSED 时携带 userId，调用方凭此吊销该用户全部会话（重放响应）
   */
  async rotate(refreshToken: string): Promise<
    | { ok: true; tokens: TokenPair; userId: string }
    | { ok: false; reason: 'INVALID' | 'REUSED'; userId?: string }
  > {
    const hash = hashToken(refreshToken);
    const session = await prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: { select: { id: true, status: true, planId: true } } },
    });

    if (!session) return { ok: false, reason: 'INVALID' };

    // 已吊销/已轮换/过期 → 重放攻击嫌疑
    if (session.revokedAt || session.replacedByHash || session.expiresAt < new Date()) {
      return { ok: false, reason: 'REUSED', userId: session.userId };
    }

    const newRefreshToken = generateRefreshToken() + randomBytes(16).toString('hex');
    const newHash = hashToken(newRefreshToken);

    const updated = await prisma.session.update({
      where: { id: session.id },
      data: { replacedByHash: newHash, lastUsedAt: new Date() },
    });

    return {
      ok: true,
      userId: session.userId,
      tokens: {
        accessToken: signAccessToken({
          sub: session.userId,
          sid: updated.id,
          plan: session.user.planId,
        }),
        refreshToken: newRefreshToken,
        expiresIn: Math.floor(parseDuration(config.JWT_ACCESS_EXPIRES_IN) / 1000),
      },
    };
  },

  /** 吊销该用户全部会话（重放响应/改密/封号） */
  async revokeAll(userId: string, reason: string): Promise<number> {
    const result = await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn({ userId, reason, count: result.count }, 'sessions_revoked_all');
    return result.count;
  },

  /** 登出当前会话 */
  async revokeById(sessionId: string, userId: string): Promise<void> {
    await prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  /** 校验会话有效性（authMiddleware 调用） */
  async isSessionActive(sessionId: string, userId: string): Promise<boolean> {
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return session !== null;
  },

  /** 列出用户会话（账户中心设备管理用） */
  async listForUser(userId: string): Promise<
    Array<{
      id: string;
      deviceInfo: Session['deviceInfo'];
      createdAt: Date;
      lastUsedAt: Date | null;
      expiresAt: Date;
    }>
  > {
    const sessions = await prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceInfo: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
    return sessions;
  },

  /** 记录重放事件并吊销全部会话 */
  async handleReuse(userId: string | null, requestId?: string): Promise<void> {
    logger.warn({ userId, requestId }, 'refresh_token_reuse_detected');
    await audit.record({
      actorType: 'SYSTEM',
      actorId: userId,
      action: 'session.reuse_detected',
      reason: 'refresh token replay detected',
      requestId,
    });
    if (userId) {
      await this.revokeAll(userId, 'refresh_token_reuse');
    }
  },
};

/**
 * 管理后台会话服务
 * 与用户端 session.service 同构：refresh hash DB 存储、30 天轮换、重放检测
 * （旧 token 重用 → 吊销该管理员全部会话并告警）。
 * 表：AdminSession（迁移 M5）。
 */

import { createHash, randomBytes } from 'node:crypto';
import type { AdminSession } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../lib/config';
import { signAdminAccessToken } from '../lib/admin-jwt';
import { parseAdminDuration } from '../lib/admin-jwt';
import { logger } from '../lib/logger';
import { audit } from '../lib/audit';
import type { AdminRole } from '@prisma/client';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + parseAdminDuration(config.ADMIN_REFRESH_EXPIRES_IN));
}

/** 生成 256-bit 随机刷新令牌 */
function generateAdminRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface AdminTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const adminSessionService = {
  /** 创建会话并签发令牌对（role 进 access payload；每次请求仍以 DB 角色为准） */
  async createSession(
    adminUserId: string,
    role: AdminRole,
    deviceInfo?: { ip?: string; userAgent?: string }
  ): Promise<AdminTokenPair> {
    const refreshToken = generateAdminRefreshToken();
    const session = await prisma.adminSession.create({
      data: {
        adminUserId,
        refreshHash: hashToken(refreshToken),
        ip: deviceInfo?.ip,
        userAgent: deviceInfo?.userAgent?.slice(0, 512),
        expiresAt: refreshExpiry(),
      },
    });
    return {
      accessToken: signAdminAccessToken({ sub: adminUserId, sid: session.id, role }),
      refreshToken,
      expiresIn: Math.floor(parseAdminDuration(config.ADMIN_ACCESS_EXPIRES_IN) / 1000),
    };
  },

  /**
   * 轮换刷新：校验 → 签发新对 → 旧会话标记 replacedBy。
   * 返回 ok:false 时 reason=REUSED 表示检测到重放；此时携带 adminUserId，
   * 调用方凭此吊销该管理员全部会话（重放响应）。
   */
  async rotate(refreshToken: string): Promise<
    | { ok: true; tokens: AdminTokenPair; adminUserId: string }
    | { ok: false; reason: 'INVALID' | 'REUSED'; adminUserId?: string }
  > {
    const hash = hashToken(refreshToken);
    const session = await prisma.adminSession.findUnique({
      where: { refreshHash: hash },
      include: { admin: { select: { id: true, role: true, status: true } } },
    });

    if (!session) return { ok: false, reason: 'INVALID' };

    // 已吊销/已轮换/过期 → 重放攻击嫌疑（与用户端一致的处理）
    if (session.revokedAt || session.replacedByHash || session.expiresAt < new Date()) {
      return { ok: false, reason: 'REUSED', adminUserId: session.adminUserId };
    }

    if (session.admin.status !== 'ACTIVE') {
      return { ok: false, reason: 'INVALID' };
    }

    const newRefreshToken = generateAdminRefreshToken();
    const newHash = hashToken(newRefreshToken);

    const updated = await prisma.adminSession.update({
      where: { id: session.id },
      data: { replacedByHash: newHash, lastUsedAt: new Date() },
    });

    return {
      ok: true,
      adminUserId: session.adminUserId,
      tokens: {
        accessToken: signAdminAccessToken({
          sub: session.adminUserId,
          sid: updated.id,
          role: session.admin.role,
        }),
        refreshToken: newRefreshToken,
        expiresIn: Math.floor(parseAdminDuration(config.ADMIN_ACCESS_EXPIRES_IN) / 1000),
      },
    };
  },

  /** 吊销该管理员全部会话（重放响应/禁用/改密） */
  async revokeAll(adminUserId: string, reason: string): Promise<number> {
    const result = await prisma.adminSession.updateMany({
      where: { adminUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn({ adminUserId, reason, count: result.count }, 'admin_sessions_revoked_all');
    return result.count;
  },

  /** 登出当前会话 */
  async revokeById(sessionId: string, adminUserId: string): Promise<void> {
    await prisma.adminSession.updateMany({
      where: { id: sessionId, adminUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  /** 校验会话有效性（adminAuthMiddleware 调用） */
  async isSessionActive(sessionId: string, adminUserId: string): Promise<boolean> {
    const session = await prisma.adminSession.findFirst({
      where: { id: sessionId, adminUserId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return session !== null;
  },

  /** 会话列表（账号安全设置页） */
  async listForAdmin(adminUserId: string): Promise<
    Array<{
      id: string;
      ip: string | null;
      userAgent: string | null;
      createdAt: Date;
      lastUsedAt: Date;
      expiresAt: Date;
    }>
  > {
    const sessions = await prisma.adminSession.findMany({
      where: { adminUserId, revokedAt: null },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
    return sessions;
  },

  /** 记录重放事件并吊销全部会话 */
  async handleReuse(adminUserId: string | null, requestId?: string): Promise<void> {
    logger.warn({ adminUserId, requestId }, 'admin_refresh_token_reuse_detected');
    await audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'admin.session.reuse_detected',
      reason: 'admin refresh token replay detected',
      requestId,
    });
    if (adminUserId) {
      await this.revokeAll(adminUserId, 'admin_refresh_token_reuse');
    }
  },
};

export type { AdminSession };

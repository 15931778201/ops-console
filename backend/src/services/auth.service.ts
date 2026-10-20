/**
 * 认证服务
 * - 注册：验证码校验 + 单事务创建用户/积分账户/邀请码/初始发放流水/审计
 * - 登录：统一错误文案（防账号枚举）+ 审计 + 会话签发
 * - 刷新：轮换 + 重放检测（见 session.service.ts）
 * - 登出：当前会话 / 全部会话
 * 注意：首发不自动发放邀请奖励，邀请关系仅作归因记录。
 */

import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../lib/config';
import { signAccessToken } from '../lib/jwt';
import { sessionService, type TokenPair } from './session.service';
import { verificationService } from './verification.service';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { AuthError, ErrorCode, ValidationError } from '../lib/errors';
import { nanoid } from 'nanoid';

export interface RegisterInput {
  email?: string;
  phone?: string;
  password: string;
  name?: string;
  verificationCode: string;
  inviteCode?: string;
}

export interface LoginInput {
  email?: string;
  phone?: string;
  password: string;
}

export interface AuthUserView {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  avatar: string | null;
  planId: string;
  planExpiresAt: Date | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: Date;
}

function toUserView(user: User): AuthUserView {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    avatar: user.avatar,
    planId: user.planId,
    planExpiresAt: user.planExpiresAt,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
    createdAt: user.createdAt,
  };
}

export const authService = {
  async register(
    input: RegisterInput,
    context: { requestId?: string; ip?: string; userAgent?: string } = {}
  ): Promise<{ user: AuthUserView; tokens: TokenPair }> {
    if (!input.email && !input.phone) {
      throw new ValidationError('邮箱或手机号至少填写一项');
    }

    // 1. 校验验证码（唯一首发验证方式）
    const target = input.email ?? input.phone!;
    await verificationService.verify(
      target,
      input.verificationCode,
      'REGISTER'
    );

    // 2. 预检唯一性（唯一约束仍是最终防线，见下方 P2002 处理）
    if (input.email) {
      const existing = await prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existing) throw new AuthError(ErrorCode.EMAIL_TAKEN, '该邮箱已被注册');
    }
    if (input.phone) {
      const existing = await prisma.user.findUnique({
        where: { phone: input.phone },
        select: { id: true },
      });
      if (existing) throw new AuthError(ErrorCode.PHONE_TAKEN, '该手机号已被注册');
    }

    // 3. 单事务：用户 + 积分账户 + 初始发放流水 + 邀请码 + 审计
    const passwordHash = await bcrypt.hash(input.password, 12);
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    let user: User;
    try {
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            phone: input.phone,
            passwordHash,
            name: input.name,
            planId: 'free',
            emailVerified: Boolean(input.email),
            phoneVerified: Boolean(input.phone),
            passwordUpdatedAt: now,
          },
        });

        // 积分账户（余额投影）
        await tx.creditAccount.create({
          data: {
            userId: created.id,
            balance: config.FREE_MONTHLY_CREDITS,
            bonusBalance: 0,
            monthlyQuota: config.FREE_MONTHLY_CREDITS,
            periodStart: now,
            periodEnd,
          },
        });

        // 追加式账本：初始免费额度发放
        await tx.creditTransaction.create({
          data: {
            userId: created.id,
            type: 'GRANT',
            status: 'SETTLED',
            amount: config.FREE_MONTHLY_CREDITS,
            deltaBalance: config.FREE_MONTHLY_CREDITS,
            deltaBonus: 0,
            balanceAfterBalance: config.FREE_MONTHLY_CREDITS,
            balanceAfterBonus: 0,
            balanceAfter: config.FREE_MONTHLY_CREDITS,
            referenceId: `grant:init:${created.id}`,
            description: '新用户免费额度',
          },
        });

        // 邀请码（渠道归因而已，首发不自动发奖）
        await tx.inviteCode.create({
          data: {
            code: nanoid(8).toUpperCase(),
            ownerUserId: created.id,
            rewardCredits: config.INVITEE_REWARD_CREDITS,
            inviterCredits: config.INVITER_REWARD_CREDITS,
          },
        });

        // 邀请关系归因（不发放奖励）
        if (input.inviteCode) {
          await this.recordInviteAttribution(tx, created.id, input.inviteCode);
        }

        await tx.auditLog.create({
          data: {
            actorType: 'USER',
            actorId: created.id,
            action: 'user.register',
            metadata: { hasEmail: Boolean(input.email), hasPhone: Boolean(input.phone) },
            requestId: context.requestId,
          },
        });

        return created;
      });
    } catch (err) {
      // 并发重复注册：唯一约束冲突 → 统一 409 语义
      if ((err as { code?: string }).code === 'P2002') {
        const field = String((err as { meta?: { target?: string[] } }).meta?.target?.[0]);
        if (field?.includes('email')) {
          throw new AuthError(ErrorCode.EMAIL_TAKEN, '该邮箱已被注册');
        }
        if (field?.includes('phone')) {
          throw new AuthError(ErrorCode.PHONE_TAKEN, '该手机号已被注册');
        }
        throw new AuthError(ErrorCode.EMAIL_TAKEN, '账号已存在，请直接登录');
      }
      throw err;
    }

    // 4. 签发会话
    const tokens = await sessionService.createSession(user.id, user.planId, {
      ip: context.ip,
      userAgent: context.userAgent,
    });

    logger.info({ userId: user.id }, 'user_registered');
    return { user: toUserView(user), tokens };
  },

  async login(
    input: LoginInput,
    context: { requestId?: string; ip?: string; userAgent?: string } = {}
  ): Promise<{ user: AuthUserView; tokens: TokenPair }> {
    if (!input.email && !input.phone) {
      throw new ValidationError('邮箱或手机号至少填写一项');
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: input.email }, { phone: input.phone }],
      },
    });

    // 统一错误：不区分"用户不存在"与"密码错误"，防账号枚举
    if (!user) {
      await audit.record({
        action: 'user.login_failed',
        reason: 'user_not_found',
        metadata: { ip: context.ip },
        requestId: context.requestId,
      });
      throw new AuthError(ErrorCode.INVALID_CREDENTIALS, '账号或密码错误');
    }

    if (user.status !== 'ACTIVE') {
      await audit.record({
        actorId: user.id,
        action: 'user.login_failed',
        reason: `status:${user.status}`,
        requestId: context.requestId,
      });
      throw new AuthError(ErrorCode.ACCOUNT_DISABLED, '账号已被禁用，请联系客服');
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      await audit.record({
        actorId: user.id,
        action: 'user.login_failed',
        reason: 'bad_password',
        metadata: { ip: context.ip },
        requestId: context.requestId,
      });
      throw new AuthError(ErrorCode.INVALID_CREDENTIALS, '账号或密码错误');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: context.ip },
    });

    const tokens = await sessionService.createSession(user.id, user.planId, {
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await audit.record({
      actorId: user.id,
      action: 'user.login',
      requestId: context.requestId,
    });
    logger.info({ userId: user.id }, 'user_logged_in');
    return { user: toUserView(user), tokens };
  },

  /** 刷新令牌（轮换 + 重放检测） */
  async refresh(
    refreshToken: string,
    context: { requestId?: string } = {}
  ): Promise<TokenPair> {
    const result = await sessionService.rotate(refreshToken);
    if (!result.ok) {
      if (result.reason === 'REUSED') {
        // 重放响应：凭 rotate 带回的 userId 吊销该用户全部会话并告警
        await sessionService.handleReuse(result.userId ?? null, context.requestId);
        throw new AuthError(ErrorCode.TOKEN_REUSED, '登录状态已失效，请重新登录');
      }
      throw new AuthError(ErrorCode.UNAUTHORIZED, '登录状态已失效，请重新登录');
    }
    return result.tokens;
  },

  async logout(sessionId: string, userId: string, requestId?: string): Promise<void> {
    await sessionService.revokeById(sessionId, userId);
    await audit.record({ actorId: userId, action: 'user.logout', requestId });
  },

  async logoutAll(userId: string, requestId?: string): Promise<void> {
    await sessionService.revokeAll(userId, 'user_logout_all');
    await audit.record({ actorId: userId, action: 'user.logout_all', requestId });
  },

  async me(userId: string): Promise<{ user: AuthUserView }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError(ErrorCode.UNAUTHORIZED, '账号不存在');
    if (user.status !== 'ACTIVE') {
      throw new AuthError(ErrorCode.ACCOUNT_DISABLED, '账号已被禁用，请联系客服');
    }
    return { user: toUserView(user) };
  },

  /** 修改密码：成功后吊销全部会话 */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    requestId?: string
  ): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AuthError(ErrorCode.UNAUTHORIZED, '账号不存在');

    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) {
      throw new AuthError(ErrorCode.INVALID_CREDENTIALS, '原密码错误');
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 12),
        passwordUpdatedAt: new Date(),
      },
    });
    await sessionService.revokeAll(userId, 'password_changed');
    await audit.record({ actorId: userId, action: 'user.password_changed', requestId });
  },

  /** 找回密码：验证码校验 → 改密 → 吊销全部会话 */
  async resetPassword(
    target: string,
    verificationCode: string,
    newPassword: string,
    requestId?: string
  ): Promise<void> {
    await verificationService.verify(target, verificationCode, 'FORGOT_PASSWORD');

    const user = await prisma.user.findFirst({
      where: { OR: [{ email: target }, { phone: target }] },
      select: { id: true },
    });
    // 统一成功响应由路由层保证；此处账号不存在也走同样流程（防枚举）
    if (!user) {
      logger.info({ requestId }, 'password_reset_target_not_found');
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 12),
        passwordUpdatedAt: new Date(),
      },
    });
    await sessionService.revokeAll(user.id, 'password_reset');
    await audit.record({ actorId: user.id, action: 'user.password_reset', requestId });
  },

  /** 邀请关系归因（首发不发放奖励） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async recordInviteAttribution(tx: any, inviteeUserId: string, inviteCode: string): Promise<void> {
    try {
      const code = await tx.inviteCode.findUnique({ where: { code: inviteCode } });
      if (!code || !code.active) return;
      if (code.ownerUserId === inviteeUserId) return; // 拒绝自邀
      if (code.expiresAt && code.expiresAt < new Date()) return;
      if (code.maxUses && code.usedCount >= code.maxUses) return;

      await tx.inviteRelation.create({
        data: {
          inviteeUserId,
          inviterUserId: code.ownerUserId,
          inviteCode: code.code,
          status: 'REGISTERED',
        },
      });
      await tx.inviteCode.update({
        where: { code: inviteCode },
        data: { usedCount: { increment: 1 } },
      });
    } catch (err) {
      // 归因失败不影响注册主流程
      logger.warn({ err, inviteeUserId }, 'invite_attribution_failed');
    }
  },
};

export { toUserView };

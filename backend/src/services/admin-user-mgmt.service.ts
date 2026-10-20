/**
 * 运营后台·用户管理服务（A6.3）
 * 能力：列表筛选 / 详情（积分+会话+订单摘要）/ 禁用启用（自动吊销会话）/
 *       强制下线 / 账本重算校验（只读对比，不平由前端标红）。
 * 约束：用户状态机只有 ACTIVE/SUSPENDED/DELETED；禁用即 SUSPENDED（保留数据可恢复），
 *       DELETED 为软删终态，后台不提供直接删除（合规保留）。
 */

import type { Prisma, UserStatus, OrderStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { sessionService } from './session.service';
import { ledgerService } from './ledger.service';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { ValidationError } from '../lib/errors';

export interface AdminUserListQuery {
  page: number;
  pageSize: number;
  search?: string;
  planId?: string;
  status?: UserStatus;
  createdFrom?: string;
  createdTo?: string;
}

export interface AdminUserListItem {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  planId: string;
  planExpiresAt: Date | null;
  status: UserStatus;
  balance: number;
  bonusBalance: number;
  createdAt: Date;
  lastLoginAt: Date | null;
}

function buildWhere(query: AdminUserListQuery): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {};
  if (query.search) {
    where.OR = [
      { email: { contains: query.search } },
      { phone: { contains: query.search } },
      { name: { contains: query.search } },
    ];
  }
  if (query.planId) where.planId = query.planId;
  if (query.status) where.status = query.status;
  if (query.createdFrom || query.createdTo) {
    where.createdAt = {};
    if (query.createdFrom) where.createdAt.gte = new Date(query.createdFrom);
    if (query.createdTo) where.createdAt.lte = new Date(query.createdTo);
  }
  return where;
}

export const adminUserMgmtService = {
  /** 列表（含余额投影；会话数等重字段放详情） */
  async listUsers(query: AdminUserListQuery): Promise<{
    items: AdminUserListItem[];
    total: number;
  }> {
    const where = buildWhere(query);
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          phone: true,
          name: true,
          planId: true,
          planExpiresAt: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          creditAccount: { select: { balance: true, bonusBalance: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    const items: AdminUserListItem[] = users.map((u) => ({
      id: u.id,
      email: u.email,
      phone: u.phone,
      name: u.name,
      planId: u.planId,
      planExpiresAt: u.planExpiresAt,
      status: u.status,
      balance: u.creditAccount?.balance ?? 0,
      bonusBalance: u.creditAccount?.bonusBalance ?? 0,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
    return { items, total };
  },

  /** 详情：用户 + 积分账户 + 活跃会话数 + 订单摘要 */
  async getUserDetail(userId: string): Promise<{
    user: Record<string, unknown>;
    credit: { balance: number; bonusBalance: number; monthlyQuota: number; periodEnd: Date | null } | null;
    activeSessions: number;
    orderSummary: { total: number; paid: number; paidAmountCents: number; refunded: number };
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        avatar: true,
        planId: true,
        planExpiresAt: true,
        status: true,
        emailVerified: true,
        phoneVerified: true,
        deviceFingerprint: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
        creditAccount: true,
      },
    });
    if (!user) throw new ValidationError('用户不存在');

    const [activeSessions, orderAgg, paidAgg, refundedCount] = await Promise.all([
      prisma.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
      prisma.order.count({ where: { userId } }),
      prisma.order.aggregate({
        where: { userId, status: 'PAID' as OrderStatus },
        _count: true,
        _sum: { amountCents: true },
      }),
      prisma.order.count({ where: { userId, status: 'REFUNDED' as OrderStatus } }),
    ]);

    const { creditAccount, ...userFields } = user;
    return {
      user: userFields,
      credit: creditAccount
        ? {
            balance: creditAccount.balance,
            bonusBalance: creditAccount.bonusBalance,
            monthlyQuota: creditAccount.monthlyQuota,
            periodEnd: creditAccount.periodEnd,
          }
        : null,
      activeSessions,
      orderSummary: {
        total: orderAgg,
        paid: paidAgg._count,
        paidAmountCents: paidAgg._sum.amountCents ?? 0,
        refunded: refundedCount,
      },
    };
  },

  /**
   * 禁用/启用用户。
   * 禁用 → SUSPENDED + 吊销全部会话（用户端下次请求即 401 ACCOUNT_DISABLED）；
   * 启用 → ACTIVE（会话不自动恢复，用户需重新登录）。
   */
  async setUserStatus(
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    actorId: string,
    reason: string,
    requestId?: string
  ): Promise<{ revokedSessions: number }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw new ValidationError('用户不存在');
    if (user.status === 'DELETED') {
      throw new ValidationError('已删除的用户不能变更状态');
    }
    if (user.status === status) {
      return { revokedSessions: 0 }; // 幂等
    }

    let revokedSessions = 0;
    if (status === 'SUSPENDED') {
      revokedSessions = await sessionService.revokeAll(userId, 'admin_suspend');
    }

    await prisma.user.update({ where: { id: userId }, data: { status: status as UserStatus } });

    await audit.record({
      actorType: 'ADMIN',
      actorId: actorId,
      action: status === 'SUSPENDED' ? 'admin.user_suspended' : 'admin.user_activated',
      targetType: 'User',
      targetId: userId,
      reason,
      metadata: { revokedSessions },
      requestId,
    });
    logger.info({ actorId, userId, status, revokedSessions }, 'admin_user_status_changed');
    return { revokedSessions };
  },

  /** 强制下线：吊销该用户全部会话（不改变账号状态） */
  async revokeUserSessions(userId: string, actorId: string, requestId?: string): Promise<number> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new ValidationError('用户不存在');
    const count = await sessionService.revokeAll(userId, 'admin_force_logout');
    await audit.record({
      actorType: 'ADMIN',
      actorId: actorId,
      action: 'admin.user_sessions_revoked',
      targetType: 'User',
      targetId: userId,
      reason: `count:${count}`,
      requestId,
    });
    return count;
  },

  /** 账本重算校验（只读）：流水重算 vs 余额投影，不平时 matches=false */
  async recomputeLedger(userId: string): Promise<{
    balance: number;
    bonusBalance: number;
    matches: boolean;
    account: { balance: number; bonusBalance: number } | null;
  }> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new ValidationError('用户不存在');
    const result = await ledgerService.recompute(userId);
    const account = await prisma.creditAccount.findUnique({
      where: { userId },
      select: { balance: true, bonusBalance: true },
    });
    return { ...result, account };
  },
};

export default adminUserMgmtService;

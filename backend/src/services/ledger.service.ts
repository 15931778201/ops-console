/**
 * 积分账本服务（不可变、可重算、可对账）
 *
 * 核心不变式：
 * 1. credit_transactions 只 INSERT；状态字段仅 PENDING→SETTLED/ROLLED_BACK 流转，金额永不改动
 * 2. credit_accounts.balance/bonusBalance 是投影：Σ 所有 status != ROLLED_BACK 的流水 delta
 * 3. 订阅积分与奖励积分分账；每笔流水记录前后快照，任意账户可由流水重算复核
 * 4. 所有写操作在同一数据库事务内完成"流水 + 投影"的原子更新
 */

import type {
  CreditAccount,
  CreditTransaction,
  LedgerEntryStatus,
  TransactionType,
  Prisma,
} from '@prisma/client';
import prisma from '../lib/prisma';
import { BillingError, ErrorCode } from '../lib/errors';
import { logger } from '../lib/logger';

export interface LedgerEntryInput {
  userId: string;
  type: TransactionType;
  /** 净变动（正数为入账；入账时与 deltaBalance+deltaBonus 保持一致） */
  amount: number;
  deltaBalance: number;
  deltaBonus: number;
  status?: LedgerEntryStatus;
  toolSlug?: string;
  fileCount?: number;
  referenceId?: string;
  billingTxnId?: string;
  linkedTxnId?: string;
  description?: string;
}

export interface AccountSnapshot {
  balance: number;
  bonusBalance: number;
  monthlyQuota: number;
  periodStart: Date | null;
  periodEnd: Date | null;
}

type Tx = Prisma.TransactionClient;

/** 行级锁读取积分账户（必须在事务内调用） */
async function lockAccount(tx: Tx, userId: string): Promise<CreditAccount> {
  const rows = await tx.$queryRaw<CreditAccount[]>`
    SELECT * FROM "credit_accounts" WHERE "userId" = ${userId} FOR UPDATE
  `;
  if (!rows[0]) {
    throw new BillingError(ErrorCode.INTERNAL_ERROR, '积分账户不存在');
  }
  return rows[0];
}

/**
 * 事务内核销一笔流水并更新投影（调用方须已持有账户行锁）
 */
async function applyEntryLocked(
  tx: Tx,
  account: CreditAccount,
  input: LedgerEntryInput
): Promise<CreditTransaction> {
  const newBalance = account.balance + input.deltaBalance;
  const newBonus = account.bonusBalance + input.deltaBonus;

  if (newBalance < 0 || newBonus < 0) {
    throw new BillingError(ErrorCode.INSUFFICIENT_CREDITS, '积分不足');
  }

  const entry = await tx.creditTransaction.create({
    data: {
      userId: input.userId,
      type: input.type,
      status: input.status ?? 'SETTLED',
      amount: input.amount,
      deltaBalance: input.deltaBalance,
      deltaBonus: input.deltaBonus,
      balanceAfterBalance: newBalance,
      balanceAfterBonus: newBonus,
      balanceAfter: newBalance + newBonus,
      toolSlug: input.toolSlug,
      fileCount: input.fileCount,
      referenceId: input.referenceId,
      billingTxnId: input.billingTxnId,
      linkedTxnId: input.linkedTxnId,
      description: input.description,
    },
  });

  await tx.creditAccount.update({
    where: { userId: input.userId },
    data: {
      balance: newBalance,
      bonusBalance: newBonus,
      version: { increment: 1 },
    },
  });

  return entry;
}

export const ledgerService = {
  /** 账户快照（只读） */
  async getAccount(userId: string): Promise<AccountSnapshot> {
    const account = await prisma.creditAccount.findUnique({ where: { userId } });
    if (!account) {
      throw new BillingError(ErrorCode.INTERNAL_ERROR, '积分账户不存在');
    }
    return {
      balance: account.balance,
      bonusBalance: account.bonusBalance,
      monthlyQuota: account.monthlyQuota,
      periodStart: account.periodStart,
      periodEnd: account.periodEnd,
    };
  },

  /**
   * 发放积分（购买到账/运营补发/补偿）
   * bonus=true 发到奖励余额（可累积），否则发到订阅余额
   */
  async grant(
    userId: string,
    amount: number,
    options: {
      type?: TransactionType;
      bonus?: boolean;
      referenceId?: string;
      description?: string;
      billingTxnId?: string;
    } = {}
  ): Promise<CreditTransaction> {
    if (amount <= 0) throw new BillingError(ErrorCode.INTERNAL_ERROR, '发放金额必须为正数');

    return prisma.$transaction(async (tx) => {
      const account = await lockAccount(tx, userId);
      return applyEntryLocked(tx, account, {
        userId,
        type: options.type ?? 'GRANT',
        amount,
        deltaBalance: options.bonus ? 0 : amount,
        deltaBonus: options.bonus ? amount : 0,
        referenceId: options.referenceId,
        billingTxnId: options.billingTxnId,
        description: options.description ?? '积分发放',
      });
    });
  },

  /**
   * 周期重置：订阅余额归位至套餐额度（保留奖励余额）
   * 语义：差额补发（Pro/VIP 归位重置）或硬重置（Free），由调用方计算差额
   */
  async resetPeriod(
    userId: string,
    targetBalance: number,
    periodStart: Date,
    periodEnd: Date
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const account = await lockAccount(tx, userId);
      const diff = targetBalance - account.balance;
      if (diff !== 0) {
        await applyEntryLocked(tx, account, {
          userId,
          type: 'RESET',
          amount: diff,
          deltaBalance: diff,
          deltaBonus: 0,
          referenceId: `reset:${userId}:${periodStart.getTime()}`,
          description: diff > 0 ? '周期额度重置（补差）' : '周期额度重置（回收）',
        });
      }
      await tx.creditAccount.update({
        where: { userId },
        data: { periodStart, periodEnd },
      });
    });
  },

  /** 人工调整（追加式；禁止直接改余额） */
  async adjust(
    userId: string,
    input: {
      deltaBalance: number;
      deltaBonus: number;
      reason: string;
      operatorId: string;
      /**
       * 外部关联 ID。审批流（A6.5）传入审批单 ID，使流水可反查审批记录；
       * 不传时退化为 `adjust:{operatorId}:{ts}`（仅时间戳，不可反查）。
       */
      referenceId?: string;
    }
  ): Promise<CreditTransaction> {
    return prisma.$transaction(async (tx) => {
      const account = await lockAccount(tx, userId);
      const entry = await applyEntryLocked(tx, account, {
        userId,
        type: 'ADJUST',
        amount: input.deltaBalance + input.deltaBonus,
        deltaBalance: input.deltaBalance,
        deltaBonus: input.deltaBonus,
        referenceId: input.referenceId ?? `adjust:${input.operatorId}:${Date.now()}`,
        description: `人工调整：${input.reason}`,
      });
      await tx.auditLog.create({
        data: {
          actorType: 'ADMIN',
          actorId: input.operatorId,
          action: 'credit.adjust',
          targetType: 'user',
          targetId: userId,
          reason: input.reason,
          metadata: {
            deltaBalance: input.deltaBalance,
            deltaBonus: input.deltaBonus,
          },
        },
      });
      return entry;
    });
  },

  /**
   * 由流水重算余额（对账用）
   * 口径：Σ 所有 status != 'ROLLED_BACK' 的 delta
   */
  async recompute(userId: string): Promise<{
    balance: number;
    bonusBalance: number;
    matches: boolean;
  }> {
    const [agg, account] = await Promise.all([
      prisma.creditTransaction.groupBy({
        by: ['userId'],
        where: { userId, status: { not: 'ROLLED_BACK' } },
        _sum: { deltaBalance: true, deltaBonus: true },
      }),
      prisma.creditAccount.findUnique({ where: { userId } }),
    ]);

    const balance = agg[0]?._sum.deltaBalance ?? 0;
    const bonusBalance = agg[0]?._sum.deltaBonus ?? 0;
    const matches =
      account !== null && account.balance === balance && account.bonusBalance === bonusBalance;

    if (!matches) {
      logger.error(
        { userId, expected: { balance, bonusBalance }, actual: account },
        'ledger_recompute_mismatch'
      );
    }
    return { balance, bonusBalance, matches };
  },

  /** 流水查询（分页） */
  async getTransactions(
    userId: string,
    options: { page?: number; pageSize?: number; type?: TransactionType } = {}
  ): Promise<{ items: CreditTransaction[]; total: number }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    const where: Prisma.CreditTransactionWhereInput = { userId };
    if (options.type) where.type = options.type;

    const [items, total] = await Promise.all([
      prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.creditTransaction.count({ where }),
    ]);
    return { items, total };
  },

  /** 抽样最近活跃账户（对账任务用） */
  async sampleActiveUsers(limit: number): Promise<string[]> {
    const rows = await prisma.creditTransaction.findMany({
      distinct: ['userId'],
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  },

  /** 供计费服务在事务内调用：锁账户 + 核销（导出给 billing.service） */
  async _applyEntryLocked(tx: Tx, account: CreditAccount, input: LedgerEntryInput) {
    return applyEntryLocked(tx, account, input);
  },

  async _lockAccount(tx: Tx, userId: string) {
    return lockAccount(tx, userId);
  },
};

export default ledgerService;

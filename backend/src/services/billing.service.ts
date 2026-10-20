/**
 * 计费服务（预扣/确认/回滚状态机）
 *
 * 状态机：PENDING → SETTLED ｜ PENDING → ROLLED_BACK ｜ PENDING → EXPIRED（终态唯一）
 *
 * 安全语义：
 * - 幂等：idempotencyKey 唯一约束（DB 为准，Redis 仅加速）；重复请求返回同一交易
 * - 并发：账户行级锁（SELECT … FOR UPDATE）串行化扣减，不透支
 * - 归属：确认/回滚只接受服务端交易 ID，校验 userId 归属
 * - 分账：回滚按交易保存的原始分账快照恢复，客户端不能指定金额
 */

import type { BillingTxnStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../lib/config';
import { ledgerService } from './ledger.service';
import { BillingError, ErrorCode, NotFoundError } from '../lib/errors';
import { logger } from '../lib/logger';

const PLAN_HIERARCHY = ['free', 'pro', 'vip'];

/**
 * 扣减分账计算（纯函数）：先订阅后奖励
 * @returns 从订阅余额扣减的部分与从奖励余额扣减的部分
 */
export function computeSplit(
  balance: number,
  bonusBalance: number,
  amount: number
): { fromBalance: number; fromBonus: number } {
  if (amount < 0) throw new Error('amount 不能为负');
  const fromBalance = Math.min(Math.max(balance, 0), amount);
  const fromBonus = amount - fromBalance;
  return { fromBalance, fromBonus };
}

export interface PreDeductInput {
  userId: string;
  toolSlug: string;
  fileCount: number;
  /** 客户端生成的幂等键（同一处理任务重试必须相同） */
  idempotencyKey: string;
}

export interface PreDeductResult {
  transactionId: string;
  toolSlug: string;
  fileCount: number;
  frozenAmount: number;
  balanceAfterBalance: number;
  balanceAfterBonus: number;
  /** 重复请求时命中既有交易 */
  idempotentReplay: boolean;
}

export const billingService = {
  /** 读取生效的工具计费规则 */
  async getRule(toolSlug: string) {
    const rule = await prisma.toolBillingRule.findUnique({ where: { toolSlug } });
    if (!rule || !rule.active) {
      throw new BillingError(ErrorCode.BILLING_RULE_NOT_FOUND, `工具未接入计费：${toolSlug}`);
    }
    return rule;
  },

  /** 预扣：校验规则/套餐/批量 → 事务内冻结积分并写账 */
  async preDeduct(input: PreDeductInput): Promise<PreDeductResult> {
    if (input.fileCount < 1) {
      throw new BillingError(ErrorCode.VALIDATION_FAILED, '文件数量不合法');
    }

    const rule = await this.getRule(input.toolSlug);
    const amount = rule.creditCost * input.fileCount;

    // 套餐与批量校验
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { planId: true, planExpiresAt: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new BillingError(ErrorCode.UNAUTHORIZED, '账号状态异常');
    }
    const planActive =
      !user.planExpiresAt || user.planExpiresAt > new Date();
    const userPlanIndex = PLAN_HIERARCHY.indexOf(user.planId);
    const requiredIndex = PLAN_HIERARCHY.indexOf(rule.minPlan);
    if (!planActive || userPlanIndex < requiredIndex) {
      throw new BillingError(
        ErrorCode.PLAN_ACCESS_DENIED,
        '当前套餐不支持该工具，请升级后使用'
      );
    }
    if (input.fileCount > rule.maxFilesPerTask) {
      throw new BillingError(
        ErrorCode.FILE_LIMIT_EXCEEDED,
        `单次最多处理 ${rule.maxFilesPerTask} 个文件`
      );
    }

    // 幂等：已存在相同 key 的交易直接返回（不重复扣费）
    const existing = await prisma.billingTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new BillingError(ErrorCode.TRANSACTION_NOT_FOUND, '交易不存在');
      }
      return {
        transactionId: existing.id,
        toolSlug: existing.toolSlug,
        fileCount: existing.fileCount,
        frozenAmount: existing.frozenAmount,
        balanceAfterBalance: existing.balanceAfterBalance,
        balanceAfterBonus: existing.balanceAfterBonus,
        idempotentReplay: true,
      };
    }

    const timeoutMs = config.BILLING_TXN_TIMEOUT_MINUTES * 60 * 1000;

    const result = await prisma.$transaction(async (tx) => {
      // 行级锁串行化余额操作
      const account = await ledgerService._lockAccount(tx, input.userId);

      const total = account.balance + account.bonusBalance;
      if (total < amount) {
        throw new BillingError(ErrorCode.INSUFFICIENT_CREDITS, '积分不足，请升级套餐或购买积分');
      }

      // 分账：先订阅后奖励
      const fromBalance = computeSplit(account.balance, account.bonusBalance, amount).fromBalance;
      const fromBonus = amount - fromBalance;

      const txn = await tx.billingTransaction.create({
        data: {
          userId: input.userId,
          toolSlug: input.toolSlug,
          fileCount: input.fileCount,
          ruleVersion: rule.ruleVersion,
          frozenAmount: amount,
          splitFromBalance: fromBalance,
          splitFromBonus: fromBonus,
          status: 'PENDING',
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(Date.now() + timeoutMs),
        },
      });

      const entry = await ledgerService._applyEntryLocked(tx, account, {
        userId: input.userId,
        type: 'CONSUME',
        status: 'PENDING',
        amount: -amount,
        deltaBalance: -fromBalance,
        deltaBonus: -fromBonus,
        toolSlug: input.toolSlug,
        fileCount: input.fileCount,
        billingTxnId: txn.id,
        referenceId: `billing:${txn.id}`,
        description: `工具预扣：${input.toolSlug} × ${input.fileCount}`,
      });

      await tx.billingTransaction.update({
        where: { id: txn.id },
        data: { ledgerTxnId: entry.id },
      });

      return {
        transactionId: txn.id,
        toolSlug: txn.toolSlug,
        fileCount: txn.fileCount,
        frozenAmount: txn.frozenAmount,
        balanceAfterBalance: entry.balanceAfterBalance,
        balanceAfterBonus: entry.balanceAfterBonus,
        idempotentReplay: false,
      };
    });

    logger.info(
      {
        userId: input.userId,
        toolSlug: input.toolSlug,
        fileCount: input.fileCount,
        amount,
        txnId: result.transactionId,
      },
      'billing_pre_deduct'
    );
    return result;
  },

  /** 确认消费：PENDING → SETTLED（幂等） */
  async confirm(transactionId: string, userId: string): Promise<void> {
    const txn = await prisma.billingTransaction.findUnique({
      where: { id: transactionId },
    });
    if (!txn || txn.userId !== userId) {
      throw new NotFoundError('交易不存在');
    }
    if (txn.status === 'SETTLED') return; // 幂等
    if (txn.status !== 'PENDING') {
      throw new BillingError(
        ErrorCode.TRANSACTION_ALREADY_SETTLED,
        '交易已终结，无法确认'
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.billingTransaction.update({
        where: { id: txn.id },
        data: { status: 'SETTLED', settledAt: new Date() },
      });
      await tx.creditTransaction.updateMany({
        where: { billingTxnId: txn.id, status: 'PENDING' },
        data: { status: 'SETTLED' },
      });
    });

    logger.info({ txnId: txn.id, userId }, 'billing_confirmed');
  },

  /** 回滚：PENDING → ROLLED_BACK，按原始分账冲正（幂等） */
  async rollback(transactionId: string, userId: string, reason?: string): Promise<void> {
    const txn = await prisma.billingTransaction.findUnique({
      where: { id: transactionId },
    });
    if (!txn || txn.userId !== userId) {
      throw new NotFoundError('交易不存在');
    }
    if (txn.status === 'ROLLED_BACK' || txn.status === 'EXPIRED') return; // 幂等
    if (txn.status !== 'PENDING') {
      throw new BillingError(
        ErrorCode.TRANSACTION_ALREADY_SETTLED,
        '交易已确认扣费，无法回滚（如需退回请走退款流程）'
      );
    }

    await prisma.$transaction(async (tx) => {
      const account = await ledgerService._lockAccount(tx, userId);

      // 原预扣流水置为已回滚
      const hold = await tx.creditTransaction.findFirst({
        where: { billingTxnId: txn.id, status: 'PENDING' },
      });
      if (hold) {
        await tx.creditTransaction.update({
          where: { id: hold.id },
          data: { status: 'ROLLED_BACK' },
        });
      }

      // 追加冲正流水：按原始分账恢复
      await ledgerService._applyEntryLocked(tx, account, {
        userId,
        type: 'REFUND',
        amount: txn.frozenAmount,
        deltaBalance: txn.splitFromBalance,
        deltaBonus: txn.splitFromBonus,
        billingTxnId: txn.id,
        linkedTxnId: hold?.id,
        referenceId: `rollback:${txn.id}`,
        description: `处理失败回滚：${txn.toolSlug}${reason ? `（${reason}）` : ''}`,
      });

      await tx.billingTransaction.update({
        where: { id: txn.id },
        data: {
          status: 'ROLLED_BACK',
          rolledBackAt: new Date(),
          rollbackReason: reason ?? 'client_rollback',
        },
      });
    });

    logger.info({ txnId: txn.id, userId, reason }, 'billing_rolled_back');
  },

  /** 交易状态查询（前端崩溃后恢复） */
  async getTransaction(transactionId: string, userId: string) {
    const txn = await prisma.billingTransaction.findUnique({
      where: { id: transactionId },
    });
    if (!txn || txn.userId !== userId) {
      throw new NotFoundError('交易不存在');
    }
    return txn;
  },

  /**
   * 超时过期：PENDING 且超过 expiresAt → EXPIRED 并冲正积分
   * 由定时任务调用（见 jobs/billing-sweeper.ts）
   */
  async expireOverdue(limit = 100): Promise<number> {
    const overdue = await prisma.billingTransaction.findMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      take: limit,
      select: { id: true, userId: true },
    });

    let expired = 0;
    for (const txn of overdue) {
      try {
        await prisma.$transaction(async (tx) => {
          const current = await tx.billingTransaction.findUnique({
            where: { id: txn.id },
            select: { status: true },
          });
          if (!current || current.status !== 'PENDING') return;

          const account = await ledgerService._lockAccount(tx, txn.userId);
          const hold = await tx.creditTransaction.findFirst({
            where: { billingTxnId: txn.id, status: 'PENDING' },
          });
          if (hold) {
            await tx.creditTransaction.update({
              where: { id: hold.id },
              data: { status: 'ROLLED_BACK' },
            });
          }
          const full = await tx.billingTransaction.findUnique({
            where: { id: txn.id },
          });
          if (full) {
            await ledgerService._applyEntryLocked(tx, account, {
              userId: txn.userId,
              type: 'REFUND',
              amount: full.frozenAmount,
              deltaBalance: full.splitFromBalance,
              deltaBonus: full.splitFromBonus,
              billingTxnId: full.id,
              linkedTxnId: hold?.id,
              referenceId: `expire:${full.id}`,
              description: `预扣超时自动冲正：${full.toolSlug}`,
            });
          }
          await tx.billingTransaction.update({
            where: { id: txn.id },
            data: {
              status: 'EXPIRED',
              rolledBackAt: new Date(),
              rollbackReason: 'timeout_expired',
            },
          });
        });
        expired += 1;
      } catch (err) {
        logger.error({ err, txnId: txn.id }, 'billing_expire_failed');
      }
    }
    return expired;
  },
};

export { PLAN_HIERARCHY };
export type { BillingTxnStatus };

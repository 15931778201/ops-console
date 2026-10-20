/**
 * 支付结算服务
 *
 * 安全语义：
 * - 支付结果以服务端验签 + 订单查证为准；客户端跳转只显示处理中
 * - 验签失败 → PAYMENT_SIGNATURE_INVALID，拒绝结算
 * - 金额/币种/订单匹配 → ORDER_AMOUNT_MISMATCH，拒绝结算
 * - 重放防护：payment_events (provider, eventId) 唯一约束
 * - 结算幂等：订单状态机 + 事务；订单 PAID 只结算一次
 * - 权益发放与订单结算同事务；积分发放流水可反查原订单
 */

import type { Order, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getAdapterByProvider, getPaymentAdapter } from './index';
import { ledgerService } from '../ledger.service';
import { sessionService } from '../session.service';
import { OrderError, PaymentError, ErrorCode } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { audit } from '../../lib/audit';
import type { PaymentProvider, QueriedOrder, VerifiedNotify } from './index';

/** 退款冲正策略（待 T0.1 最终确认的默认实现）：
 *   clawback = min(本次发放积分, 当前可用订阅余额)；不足部分记录待人工处理。 */
async function clawbackGrantedCredits(order: Order): Promise<void> {
  const granted = order.creditsGranted;
  if (granted <= 0) return;

  const account = await prisma.creditAccount.findUnique({
    where: { userId: order.userId },
  });
  if (!account) return;

  const recoverable = Math.min(granted, account.balance);
  const shortfall = granted - recoverable;

  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ balance: number; bonusBalance: number }>>`
      SELECT balance, "bonusBalance" FROM "credit_accounts" WHERE "userId" = ${order.userId} FOR UPDATE
    `;
    const current = locked[0];
    if (!current) return;

    const amount = Math.min(granted, current.balance);
    if (amount > 0) {
      await tx.creditTransaction.create({
        data: {
          userId: order.userId,
          type: 'REFUND',
          status: 'SETTLED',
          amount: -amount,
          deltaBalance: -amount,
          deltaBonus: 0,
          balanceAfterBalance: current.balance - amount,
          balanceAfterBonus: current.bonusBalance,
          balanceAfter: current.balance + current.bonusBalance - amount,
          referenceId: `refund:${order.orderNo}`,
          description: `订单退款积分冲正：${order.orderNo}`,
        },
      });
      await tx.creditAccount.update({
        where: { userId: order.userId },
        data: { balance: { decrement: amount }, version: { increment: 1 } },
      });
    }
  });

  if (shortfall > 0) {
    logger.error(
      { orderNo: order.orderNo, userId: order.userId, shortfall },
      'refund_credit_shortfall_manual_review'
    );
    await audit.record({
      actorType: 'SYSTEM',
      action: 'refund.credit_shortfall',
      targetType: 'order',
      targetId: order.orderNo,
      reason: '已消费积分超出可冲正余额，需人工处理',
      metadata: { granted, recoverable, shortfall },
    });
  }
}

/** 权益发放：套餐期限 + 积分（与订单结算同事务） */
async function grantEntitlements(tx: Prisma.TransactionClient, order: Order): Promise<void> {
  const now = new Date();

  const user = await tx.user.findUnique({
    where: { id: order.userId },
    select: { planId: true, planExpiresAt: true },
  });
  if (!user) throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '用户不存在');

  // 期限递延：在现有到期时间与当前时间中取较晚者
  const base = user.planExpiresAt && user.planExpiresAt > now ? user.planExpiresAt : now;
  const newExpiry = new Date(base.getTime() + order.periodMonths * 30 * 86400000);

  await tx.user.update({
    where: { id: order.userId },
    data: {
      planId: order.planId,
      planExpiresAt: newExpiry,
    },
  });

  // 积分发放（快照中的月度额度 × 周期）
  const snapshot = order.priceSnapshot as { monthlyCredits?: number } | null;
  const credits = (snapshot?.monthlyCredits ?? 0) * order.periodMonths;

  if (credits > 0) {
    const account = await tx.creditAccount.findUnique({
      where: { userId: order.userId },
      select: { id: true, balance: true, bonusBalance: true },
    });
    if (!account) {
      throw new OrderError(ErrorCode.INTERNAL_ERROR, '积分账户不存在');
    }
    await tx.creditTransaction.create({
      data: {
        userId: order.userId,
        type: 'GRANT',
        status: 'SETTLED',
        amount: credits,
        deltaBalance: credits,
        deltaBonus: 0,
        balanceAfterBalance: account.balance + credits,
        balanceAfterBonus: account.bonusBalance,
        balanceAfter: account.balance + account.bonusBalance + credits,
        referenceId: `grant:order:${order.orderNo}`,
        description: `套餐购买到账：${order.planId} × ${order.periodMonths}个月`,
      },
    });
    await tx.creditAccount.update({
      where: { userId: order.userId },
      data: {
        balance: { increment: credits },
        monthlyQuota: snapshot?.monthlyCredits ?? undefined,
        version: { increment: 1 },
      },
    });
  }

  await tx.order.update({
    where: { orderNo: order.orderNo },
    data: { creditsGranted: credits, grantTxnId: `grant:order:${order.orderNo}` },
  });
}

export const settlementService = {
  /**
   * 处理支付回调
   * 返回处理结果；验签失败/金额不符抛错（由路由层转换为渠道 ACK fail）
   */
  async handlePaymentNotify(params: {
    provider: PaymentProvider;
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ duplicate: boolean; orderNo: string }> {
    const adapter = getAdapterByProvider(params.provider);

    // 1. 验签 + 规范化（失败抛 PAYMENT_SIGNATURE_INVALID）
    const verified: VerifiedNotify = await adapter.verifyNotify({
      headers: params.headers,
      rawBody: params.rawBody,
    });

    // 2. 事件落库（重放防护：provider+eventId 唯一）
    let event;
    try {
      event = await prisma.paymentEvent.create({
        data: {
          orderNo: verified.orderNo,
          provider: params.provider,
          eventId: verified.eventId,
          eventType: 'payment.notify',
          rawPayload: JSON.parse(params.rawBody) as object,
          signatureValid: true,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // 重复回调：已处理过，直接 ACK 成功
        logger.info({ provider: params.provider, eventId: verified.eventId }, 'duplicate_notify');
        return { duplicate: true, orderNo: verified.orderNo };
      }
      throw err;
    }

    // 3. 订单匹配 + 事务结算
    try {
      await this.settleOrder(verified);
      await prisma.paymentEvent.update({
        where: { id: event.id },
        data: { processed: true },
      });
      return { duplicate: false, orderNo: verified.orderNo };
    } catch (err) {
      await prisma.paymentEvent.update({
        where: { id: event.id },
        data: { processError: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  },

  /** 订单匹配 → 事务结算 → 权益发放（幂等） */
  async settleOrder(verified: VerifiedNotify): Promise<void> {
    const order = await prisma.order.findUnique({ where: { orderNo: verified.orderNo } });
    if (!order) {
      throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '订单不存在');
    }
    if (order.amountCents !== verified.amountCents) {
      throw new OrderError(ErrorCode.ORDER_AMOUNT_MISMATCH, '支付金额与订单不一致');
    }
    if (order.currency !== verified.currency) {
      throw new OrderError(ErrorCode.ORDER_AMOUNT_MISMATCH, '支付币种与订单不一致');
    }

    await prisma.$transaction(async (tx) => {
      // 状态机守卫：仅 PENDING 可结算（PAID 只结算一次；CLOSED 需人工）
      const current = await tx.order.findUnique({
        where: { orderNo: order.orderNo },
        select: { status: true },
      });
      if (!current || current.status !== 'PENDING') {
        if (current?.status === 'PAID') {
          logger.info({ orderNo: order.orderNo }, 'order_already_paid_skip');
          return;
        }
        throw new OrderError(ErrorCode.ORDER_EXPIRED, '订单状态不允许结算');
      }

      await tx.order.update({
        where: { orderNo: order.orderNo },
        data: {
          status: 'PAID',
          paidAt: verified.paidAt ?? new Date(),
          thirdPartyTradeNo: verified.channelTradeNo || order.thirdPartyTradeNo,
        },
      });

      await grantEntitlements(tx, { ...order, status: 'PAID' });
    });

    logger.info(
      { orderNo: order.orderNo, userId: order.userId, channelTradeNo: verified.channelTradeNo },
      'order_settled'
    );
    await audit.record({
      actorType: 'SYSTEM',
      action: 'order.paid',
      targetType: 'order',
      targetId: order.orderNo,
      metadata: { userId: order.userId, amountCents: order.amountCents },
    });
  },

  /** 渠道查单补偿结算（无回调时恢复） */
  async settleFromQuery(order: Order, queried: QueriedOrder): Promise<void> {
    if (order.amountCents !== queried.amountCents && queried.amountCents !== undefined) {
      throw new OrderError(ErrorCode.ORDER_AMOUNT_MISMATCH, '渠道金额与订单不一致');
    }
    await this.settleOrder({
      provider: order.channel === 'WECHAT' ? 'wechat' : 'alipay',
      eventId: `query:${order.orderNo}:${Date.now()}`,
      channelTradeNo: queried.channelTradeNo ?? '',
      orderNo: order.orderNo,
      amountCents: order.amountCents,
      currency: order.currency,
      status: 'PAID',
      paidAt: queried.paidAt,
    });
  },

  /** 处理退款回调 */
  async handleRefundNotify(params: {
    provider: PaymentProvider;
    rawBody: string;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ duplicate: boolean; orderNo: string }> {
    const adapter = getAdapterByProvider(params.provider);
    const verified = await adapter.verifyRefundNotify({
      headers: params.headers,
      rawBody: params.rawBody,
    });

    let event;
    try {
      event = await prisma.paymentEvent.create({
        data: {
          orderNo: verified.orderNo,
          provider: params.provider,
          eventId: `refund:${verified.eventId}`,
          eventType: 'refund.notify',
          rawPayload: JSON.parse(params.rawBody) as object,
          signatureValid: true,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return { duplicate: true, orderNo: verified.orderNo };
      }
      throw err;
    }

    try {
      const order = await prisma.order.findUnique({ where: { orderNo: verified.orderNo } });
      if (!order) throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '订单不存在');

      await prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({
          where: { orderNo: order.orderNo },
          select: { status: true },
        });
        if (!current || current.status === 'REFUNDED') return;
        if (current.status !== 'REFUNDING' && current.status !== 'PAID') {
          throw new OrderError(ErrorCode.REFUND_NOT_ALLOWED, '订单状态不允许退款');
        }
        await tx.order.update({
          where: { orderNo: order.orderNo },
          data: {
            status: 'REFUNDED',
            refundedAt: new Date(),
            refundId: verified.refundId ?? order.refundId,
          },
        });
      });

      await clawbackGrantedCredits(order);
      await prisma.paymentEvent.update({
        where: { id: event.id },
        data: { processed: true },
      });

      await audit.record({
        actorType: 'SYSTEM',
        action: 'order.refunded',
        targetType: 'order',
        targetId: order.orderNo,
      });
      logger.info({ orderNo: order.orderNo }, 'order_refunded');
      return { duplicate: false, orderNo: verified.orderNo };
    } catch (err) {
      await prisma.paymentEvent.update({
        where: { id: event.id },
        data: { processError: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  },

  /**
   * 每日渠道对账：本地订单 vs 渠道状态。
   * 差异落 ReconciliationRecord（迁移 M5）供运营后台工作台处理：
   *   PAID_LOCAL_PENDING 渠道已付本地未结 → 自动补结算（AUTO_SETTLED）
   *   PAID_LOCAL_UNKNOWN 本地已结渠道无记录
   *   AMOUNT_MISMATCH    金额不一致（禁止自动改金额，交财务）
   *   DUPLICATE_NOTIFY   重复回调（已幂等拦截，仅留痕）
   */
  async reconcileWithChannel(): Promise<{ checked: number; mismatched: number; recorded: number }> {
    const adapter = getPaymentAdapter();
    const pending = await prisma.order.findMany({
      where: { status: 'PENDING', createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      take: 200,
      select: { orderNo: true },
    });
    const paid = await prisma.order.findMany({
      where: { status: 'PAID', paidAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      take: 200,
      select: { orderNo: true, amountCents: true },
    });

    let mismatched = 0;
    let recorded = 0;

    /** 记录差异（失败不影响对账主流程） */
    const recordDiff = async (
      orderNo: string,
      localStatus: string,
      channelStatus: string,
      diffType: string,
      action: 'AUTO_SETTLED' | null,
      note?: string
    ): Promise<void> => {
      try {
        const order = await prisma.order.findUnique({
          where: { orderNo },
          select: { channel: true },
        });
        if (!order) return;
        await prisma.reconciliationRecord.create({
          data: {
            channel: order.channel,
            orderNo,
            localStatus: localStatus as never,
            channelStatus,
            diffType,
            action,
            note,
          },
        });
        recorded += 1;
      } catch (err) {
        logger.error({ err, orderNo, diffType }, 'reconcile_record_failed');
      }
    };

    for (const { orderNo } of pending) {
      try {
        const order = await prisma.order.findUnique({ where: { orderNo } });
        if (!order) continue;
        const queried = await adapter.queryOrder(orderNo);
        if (
          queried.amountCents !== undefined &&
          queried.amountCents !== order.amountCents
        ) {
          mismatched += 1;
          await recordDiff(
            orderNo,
            order.status,
            queried.status,
            'AMOUNT_MISMATCH',
            null,
            `本地 ${order.amountCents} 分 / 渠道 ${queried.amountCents} 分`
          );
          continue;
        }
        if (queried.status === 'PAID') {
          mismatched += 1;
          await this.settleFromQuery(order, queried);
          await recordDiff(orderNo, order.status, queried.status, 'PAID_LOCAL_PENDING', 'AUTO_SETTLED');
        }
      } catch (err) {
        logger.error({ err, orderNo }, 'reconcile_query_failed');
      }
    }

    for (const { orderNo } of paid) {
      try {
        const queried = await adapter.queryOrder(orderNo);
        if (queried.status !== 'PAID') {
          mismatched += 1;
          await recordDiff(
            orderNo,
            'PAID',
            queried.status,
            'PAID_LOCAL_UNKNOWN',
            null,
            '本地已结但渠道未查到支付记录，需人工核实'
          );
        }
      } catch (err) {
        logger.error({ err, orderNo }, 'reconcile_paid_query_failed');
      }
    }

    return { checked: pending.length + paid.length, mismatched, recorded };
  },
};

export { clawbackGrantedCredits };

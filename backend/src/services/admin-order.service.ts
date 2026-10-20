/**
 * 运营后台·订单管理服务（A6.4）
 * 能力：多维筛选列表 / 详情（含 PaymentEvent 时间线）/ 渠道查单同步（补结算）。
 * 约束：
 * - 只读能力不写库（user:read 即可）；查单同步需 order:sync。
 * - 补结算复用 settlementService.settleFromQuery（状态机守卫保证幂等，不重复发权益）。
 * - 强制关单（order:close）等 A6.5 审批流开放后接入。
 */

import type { OrderStatus, PaymentChannel, Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { settlementService } from './payment/settlement.service';
import { getPaymentAdapter, type PaymentAdapter } from './payment';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { OrderError, ErrorCode } from '../lib/errors';

export interface AdminOrderListQuery {
  page: number;
  pageSize: number;
  orderNo?: string;
  userId?: string;
  channel?: PaymentChannel;
  status?: OrderStatus;
  planId?: string;
  createdFrom?: string;
  createdTo?: string;
}

function buildWhere(query: AdminOrderListQuery): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  if (query.orderNo) where.orderNo = { contains: query.orderNo };
  if (query.userId) where.userId = query.userId;
  if (query.channel) where.channel = query.channel;
  if (query.status) where.status = query.status;
  if (query.planId) where.planId = query.planId;
  if (query.createdFrom || query.createdTo) {
    where.createdAt = {};
    if (query.createdFrom) where.createdAt.gte = new Date(query.createdFrom);
    if (query.createdTo) where.createdAt.lte = new Date(query.createdTo);
  }
  return where;
}

/**
 * 查单适配器：与结算/对账任务一致，统一走当前启用的适配器
 * （config.PAYMENT_PROVIDER 决定；开发为 mock，生产为已验收渠道）。
 * 订单的 channel 字段是用户下单时选择的渠道标识，不等于当前启用适配器。
 */
function resolveAdapter(): PaymentAdapter {
  return getPaymentAdapter();
}

export const adminOrderService = {
  /** 列表（含用户标识与权益发放结果） */
  async listOrders(query: AdminOrderListQuery): Promise<{
    items: Array<Record<string, unknown>>;
    total: number;
    summary: { totalAmountCents: number; paidCount: number };
  }> {
    const where = buildWhere(query);
    const [orders, total, paidAgg] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, phone: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.order.count({ where }),
      prisma.order.aggregate({
        where,
        _count: true,
        _sum: { amountCents: true },
      }),
    ]);

    return {
      items: orders.map((o) => ({
        orderNo: o.orderNo,
        userId: o.userId,
        user: o.user,
        planId: o.planId,
        amountCents: o.amountCents,
        currency: o.currency,
        periodMonths: o.periodMonths,
        channel: o.channel,
        status: o.status,
        creditsGranted: o.creditsGranted,
        thirdPartyTradeNo: o.thirdPartyTradeNo,
        paidAt: o.paidAt,
        expiresAt: o.expiresAt,
        refundedAt: o.refundedAt,
        createdAt: o.createdAt,
      })),
      total,
      summary: {
        totalAmountCents: paidAgg._sum.amountCents ?? 0,
        paidCount: paidAgg._count,
      },
    };
  },

  /** 详情：订单 + 用户 + 支付事件时间线 + 发放流水 */
  async getOrderDetail(orderNo: string): Promise<{
    order: Record<string, unknown>;
    user: Record<string, unknown> | null;
    events: Array<Record<string, unknown>>;
    grantTransaction: Record<string, unknown> | null;
  }> {
    const order = await prisma.order.findUnique({
      where: { orderNo },
      include: {
        user: {
          select: { id: true, email: true, phone: true, name: true, planId: true, status: true },
        },
        paymentEvents: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            provider: true,
            eventType: true,
            signatureValid: true,
            processed: true,
            processError: true,
            createdAt: true,
          },
        },
      },
    });
    if (!order) throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '订单不存在', 404);

    const grantTransaction = order.grantTxnId
      ? await prisma.creditTransaction.findUnique({
          where: { id: order.grantTxnId },
          select: {
            id: true,
            type: true,
            status: true,
            amount: true,
            deltaBalance: true,
            deltaBonus: true,
            balanceAfter: true,
            createdAt: true,
          },
        })
      : null;

    const { user, paymentEvents, ...orderFields } = order;
    return {
      order: orderFields,
      user: user as Record<string, unknown> | null,
      events: paymentEvents as unknown as Array<Record<string, unknown>>,
      grantTransaction: grantTransaction as Record<string, unknown> | null,
    };
  },

  /**
   * 渠道查单同步（人工/定时触发）：
   * - 本地 PENDING 且渠道已付 → 补结算（幂等，状态机守卫）
   * - 本地已结且渠道无记录/未付 → 返回差异，不自动改状态（交人工判断）
   */
  async syncOrder(
    orderNo: string,
    actorId: string,
    requestId?: string
  ): Promise<{
    orderNo: string;
    localStatus: OrderStatus;
    channelStatus: string;
    settled: boolean;
    note?: string;
  }> {
    const order = await prisma.order.findUnique({ where: { orderNo } });
    if (!order) throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '订单不存在', 404);

    const adapter = resolveAdapter();

    let channelStatus = 'UNKNOWN';
    let settled = false;
    let note: string | undefined;

    try {
      const queried = await adapter.queryOrder(orderNo);
      channelStatus = queried.status;
      if (queried.amountCents !== undefined && queried.amountCents !== order.amountCents) {
        note = `金额不一致：本地 ${order.amountCents} / 渠道 ${queried.amountCents}`;
      }
      if (queried.status === 'PAID' && order.status === 'PENDING') {
        await settlementService.settleFromQuery(order, queried);
        settled = true;
        note = note ?? '渠道已付本地未结 → 已补结算';
      } else if (order.status === 'PAID' && queried.status !== 'PAID') {
        note = `本地已结但渠道状态为 ${queried.status}，需人工核实`;
      }
    } catch (err) {
      note = `渠道查询失败：${(err as Error).message.slice(0, 200)}`;
      logger.error({ err, orderNo }, 'admin_sync_order_query_failed');
    }

    await audit.record({
      actorType: 'ADMIN',
      actorId: actorId,
      action: 'admin.order_synced',
      targetType: 'Order',
      targetId: orderNo,
      reason: note,
      metadata: { settled, channelStatus, localStatus: order.status },
      requestId,
    });

    const after = await prisma.order.findUnique({
      where: { orderNo },
      select: { status: true },
    });
    return {
      orderNo,
      localStatus: after?.status ?? order.status,
      channelStatus,
      settled,
      note,
    };
  },
};

export default adminOrderService;

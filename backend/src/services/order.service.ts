/**
 * 订单服务
 * - 服务端定价：创建订单时重读套餐价格/周期/权益，忽略客户端传入金额
 * - 价格快照：订单保存下单时的套餐与价格，防止后续调价影响历史订单
 * - 幂等：idempotencyKey 唯一约束；待支付超时自动关闭
 */

import type { Order, PaymentChannel, Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { getPaymentAdapter } from './payment';
import { settlementService } from './payment/settlement.service';
import { OrderError, PaymentError, ErrorCode, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { nanoid } from 'nanoid';

const ORDER_EXPIRE_MINUTES = 30;
/** 退款窗口（天）——具体政策以 docs/商务规则表.md 为准 */
export const REFUND_WINDOW_DAYS = 7;

export interface CreateOrderInput {
  userId: string;
  planId: string;
  periodMonths: number;
  channel: PaymentChannel;
  idempotencyKey: string;
  clientType: 'desktop' | 'web';
}

export const orderService = {
  /** 创建订单并发起渠道支付 */
  async createOrder(input: CreateOrderInput): Promise<{
    order: Order;
    paymentParams: Record<string, unknown>;
  }> {
    if (![1, 3, 12].includes(input.periodMonths)) {
      throw new ValidationError('售卖周期仅支持 1/3/12 个月');
    }

    // 幂等：相同 key 返回既有订单（不重复创建支付单）
    const existing = await prisma.order.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '订单不存在');
      }
      if (existing.status !== 'PENDING') {
        return { order: existing, paymentParams: {} };
      }
      // 仍待支付：重新发起渠道支付参数
      const adapter = getPaymentAdapter();
      const created = await adapter.createPayment({
        orderNo: existing.orderNo,
        amountCents: existing.amountCents,
        currency: existing.currency,
        description: `合羽PDF ${existing.planId} 套餐`,
        notifyUrl: this.notifyUrl(),
        clientType: input.clientType,
      });
      return { order: existing, paymentParams: created.params };
    }

    // 服务端定价（忽略任何客户端金额）
    const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan) {
      throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '套餐不存在', 404);
    }
    if (!plan.active) {
      // 下架与不存在必须区分：前者是运营动作（可引导换套餐），后者是用户/客户端传错ID
      throw new OrderError(ErrorCode.PLAN_UNAVAILABLE, '该套餐已下架，请选择其他套餐', 409);
    }
    if (plan.id === 'free') {
      throw new ValidationError('免费套餐无需购买');
    }

    const amountCents = plan.priceCents * input.periodMonths;
    const priceSnapshot = {
      planId: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      periodMonths: input.periodMonths,
      monthlyCredits: plan.monthlyCredits,
      maxFiles: plan.maxFiles,
      costTierAccess: plan.costTierAccess,
    };

    const orderNo = `ORD${Date.now()}${nanoid(6).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + ORDER_EXPIRE_MINUTES * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        orderNo,
        userId: input.userId,
        planId: plan.id,
        amountCents,
        currency: 'CNY',
        periodMonths: input.periodMonths,
        priceSnapshot,
        idempotencyKey: input.idempotencyKey,
        channel: input.channel,
        status: 'PENDING',
        expiresAt,
      },
    });

    const adapter = getPaymentAdapter();
    try {
      const created = await adapter.createPayment({
        orderNo: order.orderNo,
        amountCents,
        currency: 'CNY',
        description: `合羽PDF ${plan.name} ${input.periodMonths}个月`,
        notifyUrl: this.notifyUrl(),
        clientType: input.clientType,
      });
      if (created.channelTradeNo) {
        await prisma.order.update({
          // 注意：主键是 uuid，订单号是唯一业务字段——必须用 orderNo 定位
          where: { orderNo },
          data: { thirdPartyTradeNo: created.channelTradeNo },
        });
      }
      logger.info(
        { orderNo, userId: input.userId, planId: plan.id, amountCents },
        'order_created'
      );
      return { order: { ...order, thirdPartyTradeNo: created.channelTradeNo ?? null }, paymentParams: created.params };
    } catch (err) {
      // 渠道下单失败：关闭订单，避免悬挂待支付
      // 用 updateMany 而非 update：关闭失败不应掩盖原始渠道错误
      await prisma.order.updateMany({
        where: { orderNo, status: 'PENDING' },
        data: { status: 'CLOSED', closedAt: new Date(), failureReason: 'channel_create_failed' },
      });
      throw err instanceof PaymentError
        ? err
        : new PaymentError(ErrorCode.INTERNAL_ERROR, '支付渠道暂不可用，请稍后重试');
    }
  },

  notifyUrl(): string {
    const base = process.env.PAYMENT_NOTIFY_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
    return `${base}/api/payment/notify`;
  },

  /** 用户订单列表（仅本人） */
  async listUserOrders(
    userId: string,
    options: { page?: number; pageSize?: number } = {}
  ): Promise<{ items: Order[]; total: number }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 20));
    const [items, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where: { userId } }),
    ]);
    return { items, total };
  },

  /** 用户订单详情（仅本人；越权视为不存在） */
  async getUserOrder(userId: string, orderNo: string): Promise<Order> {
    const order = await prisma.order.findUnique({ where: { orderNo } });
    if (!order || order.userId !== userId) {
      throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '订单不存在');
    }
    return order;
  },

  /** 关闭超时未支付订单 */
  async closeExpired(limit = 100): Promise<number> {
    const result = await prisma.order.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      data: { status: 'CLOSED', closedAt: new Date(), failureReason: 'timeout_closed' },
    });
    if (result.count > 0) {
      logger.info({ count: result.count }, 'orders_closed_expired');
    }
    return result.count;
  },

  /** 申请退款：订单须已支付且在退款窗口内 */
  async requestRefund(
    userId: string,
    orderNo: string,
    reason: string
  ): Promise<{ refundId: string }> {
    const order = await this.getUserOrder(userId, orderNo);
    if (order.status !== 'PAID') {
      throw new OrderError(ErrorCode.REFUND_NOT_ALLOWED, '当前订单状态不支持退款');
    }
    if (order.paidAt) {
      const deadline = new Date(order.paidAt.getTime() + REFUND_WINDOW_DAYS * 86400000);
      if (deadline < new Date()) {
        throw new OrderError(ErrorCode.REFUND_NOT_ALLOWED, '已超过退款有效期，请联系客服');
      }
    }

    const refundNo = `RF${Date.now()}${nanoid(4).toUpperCase()}`;
    const adapter = getPaymentAdapter();
    const { refundId } = await adapter.createRefund({
      orderNo: order.orderNo,
      channelTradeNo: order.thirdPartyTradeNo ?? '',
      refundNo,
      amountCents: order.amountCents,
      reason,
      notifyUrl: this.notifyUrl(),
    });

    await prisma.order.update({
      where: { orderNo },
      data: { status: 'REFUNDING', refundId },
    });
    logger.info({ orderNo, userId, refundId }, 'refund_requested');
    return { refundId };
  },

  /** 渠道查单补偿：支付结果未知时以服务端查证为准 */
  async syncWithChannel(orderNo: string): Promise<Order> {
    const order = await prisma.order.findUnique({ where: { orderNo } });
    if (!order) throw new OrderError(ErrorCode.ORDER_NOT_FOUND, '订单不存在');
    if (order.status !== 'PENDING') return order;

    const adapter = getPaymentAdapter();
    const queried = await adapter.queryOrder(orderNo);
    if (queried.status === 'PAID') {
      // 以查单结果补一次结算（验签过的等价信息）
      await settlementService.settleFromQuery(order, queried);
      const updated = await prisma.order.findUnique({ where: { orderNo } });
      if (updated) return updated;
    }
    return order;
  },
};

export type { Order, PaymentChannel };
export type { Prisma };

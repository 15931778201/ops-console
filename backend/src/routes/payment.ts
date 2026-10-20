/**
 * 支付/订单路由（需认证，退款回调除外）
 * - GET  /plans                套餐目录（价格唯一来源）
 * - POST /create-order         创建订单并发起支付
 * - GET  /orders               我的订单列表
 * - GET  /orders/:orderNo      订单详情
 * - POST /orders/:orderNo/sync 渠道查单恢复
 * - POST /orders/:orderNo/refund 申请退款
 * - POST /mock-notify          （仅 Mock 渠道 + 非生产）模拟回调，供端到端联调
 */

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { orderService } from '../services/order.service';
import { settlementService } from '../services/payment/settlement.service';
import { buildMockNotify } from '../services/payment/mock';
import { asyncHandler } from '../lib/async-handler';
import { sendSuccess, sendPaginated } from '../lib/response';
import { rateLimiter, RATE_RULES } from '../lib/rate-limit';
import { config } from '../lib/config';
import prisma from '../lib/prisma';
import { PaymentError, ErrorCode } from '../lib/errors';
import { isEnabled, getPublicFlags } from '../services/feature-flag.service';

const router = Router();

/** GET /api/payment/plans —— 套餐目录 */
router.get('/plans', asyncHandler(async (_req, res) => {
  const plans = await prisma.plan.findMany({
    where: { active: true },
    orderBy: { priceCents: 'asc' },
  });
  sendSuccess(res, { items: plans });
}));

/**
 * GET /api/payment/flags —— 用户端开关（公开、只读）
 * 前端据此隐藏停收期间的购买 CTA（验收标准第 5 条：用户端 CTA 隐藏）。
 * 故意挂在 authMiddleware 之前：未登录用户也要能知道「现在不能买」。
 */
router.get('/flags', asyncHandler(async (_req, res) => {
  sendSuccess(res, await getPublicFlags());
}));

router.use(authMiddleware);

const createOrderSchema = z.object({
  planId: z.string().min(1).max(32),
  periodMonths: z.union([z.literal(1), z.literal(3), z.literal(12)]),
  channel: z.enum(['WECHAT', 'ALIPAY']),
  idempotencyKey: z.string().min(8).max(128),
  clientType: z.enum(['desktop', 'web']).default('web'),
});

/** POST /api/payment/create-order */
router.post(
  '/create-order',
  rateLimiter('paymentCreate', RATE_RULES.paymentCreate, (req: AuthRequest) => req.user?.id ?? 'anon'),
  asyncHandler(async (req: AuthRequest, res) => {
    const data = createOrderSchema.parse(req.body);

    // 停收开关（A6.8）：只挡「新订单创建」这一个写入口。
    // 查询（orders / plans）与退款（refund）刻意不受影响——已付款用户必须能查能退，
    // 这是验收标准第 5 条的要求。
    if (!(await isEnabled('paymentAcceptingOrders'))) {
      // 503 而非 400：这是「暂时不可用」，前端应提示稍后再试而非「你参数错了」
      throw new PaymentError(
        ErrorCode.FEATURE_DISABLED,
        '当前暂停新订单购买，已购买用户不受影响',
        503
      );
    }

    const { order, paymentParams } = await orderService.createOrder({
      userId: req.user!.id,
      planId: data.planId,
      periodMonths: data.periodMonths,
      channel: data.channel,
      idempotencyKey: data.idempotencyKey,
      clientType: data.clientType,
    });
    sendSuccess(res, {
      order: {
        orderNo: order.orderNo,
        planId: order.planId,
        amountCents: order.amountCents,
        currency: order.currency,
        periodMonths: order.periodMonths,
        status: order.status,
        expiresAt: order.expiresAt,
        channel: order.channel,
      },
      paymentParams,
    });
  })
);

/** GET /api/payment/orders */
router.get('/orders', asyncHandler(async (req: AuthRequest, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));
  const { items, total } = await orderService.listUserOrders(req.user!.id, { page, pageSize });
  sendPaginated(res, items, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}));

/** GET /api/payment/orders/:orderNo */
router.get('/orders/:orderNo', asyncHandler(async (req: AuthRequest, res) => {
  const order = await orderService.getUserOrder(req.user!.id, req.params.orderNo!);
  sendSuccess(res, order);
}));

/** POST /api/payment/orders/:orderNo/sync —— 渠道查单恢复 */
router.post('/orders/:orderNo/sync', asyncHandler(async (req: AuthRequest, res) => {
  const order = await orderService.syncWithChannel(req.params.orderNo!);
  if (order.userId !== req.user!.id) {
    throw new PaymentError(ErrorCode.ORDER_NOT_FOUND, '订单不存在');
  }
  sendSuccess(res, order);
}));

/** POST /api/payment/orders/:orderNo/refund */
router.post('/orders/:orderNo/refund', asyncHandler(async (req: AuthRequest, res) => {
  const data = z
    .object({ reason: z.string().min(2).max(200) })
    .parse(req.body ?? {});
  const result = await orderService.requestRefund(req.user!.id, req.params.orderNo!, data.reason);
  sendSuccess(res, result);
}));

/**
 * POST /api/payment/mock-notify
 * 仅 Mock 渠道且非生产环境：构造签名回调并驱动完整结算流程（端到端联调用）。
 */
router.post('/mock-notify', asyncHandler(async (req: AuthRequest, res) => {
  if (config.PAYMENT_PROVIDER !== 'mock' || config.NODE_ENV === 'production') {
    throw new PaymentError(ErrorCode.FEATURE_DISABLED, 'Mock 回调仅在开发/预生产可用');
  }
  const data = z
    .object({
      orderNo: z.string().min(1),
      status: z.enum(['PAID', 'REFUNDED', 'CLOSED', 'FAILED']),
      amountCents: z.number().int().positive().optional(),
    })
    .parse(req.body);

  const order = await orderService.getUserOrder(req.user!.id, data.orderNo);
  const notify = buildMockNotify({
    orderNo: order.orderNo,
    amountCents: data.amountCents ?? order.amountCents,
    currency: order.currency,
    status: data.status,
  });

  const result =
    data.status === 'REFUNDED'
      ? await settlementService.handleRefundNotify({
          provider: 'mock',
          rawBody: notify.rawBody,
          headers: notify.headers,
        })
      : await settlementService.handlePaymentNotify({
          provider: 'mock',
          rawBody: notify.rawBody,
          headers: notify.headers,
        });

  sendSuccess(res, result);
}));

export default router;

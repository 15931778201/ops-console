/**
 * 运营后台·订单管理（/api/admin/v1/orders）
 * 权限：order:read（列表/详情）、order:sync（渠道查单补结算，OPERATOR 可直接执行）。
 * 强制关单（order:close）待 A6.5 审批流开放后接入。
 */

import { Router } from 'express';
import { z } from 'zod';
import { adminOrderService } from '../../services/admin-order.service';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { asyncHandler } from '../../lib/async-handler';
import { sendPaginated, sendSuccess } from '../../lib/response';

const router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  orderNo: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  channel: z.enum(['WECHAT', 'ALIPAY']).optional(),
  status: z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDING', 'REFUNDED', 'CLOSED']).optional(),
  planId: z.string().max(32).optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
});

/** GET /orders —— 列表（含金额汇总） */
router.get(
  '/',
  rbac('order:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const query = listQuery.parse(req.query);
    const { items, total, summary } = await adminOrderService.listOrders(query);
    sendPaginated(res, items, {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    }, { summary });
  })
);

/** GET /orders/:orderNo —— 详情（支付事件时间线 + 发放流水） */
router.get(
  '/:orderNo',
  rbac('order:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const detail = await adminOrderService.getOrderDetail(req.params.orderNo!);
    sendSuccess(res, detail);
  })
);

/** POST /orders/:orderNo/sync —— 渠道查单（必要时补结算，幂等） */
router.post(
  '/:orderNo/sync',
  rbac('order:sync'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const result = await adminOrderService.syncOrder(
      req.params.orderNo!,
      req.admin!.id,
      req.requestId
    );
    sendSuccess(res, result);
  })
);

export default router;

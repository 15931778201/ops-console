/**
 * 运营后台·对账工作台（/api/admin/v1/reconciliations）
 * 权限：reconcile:read（差异列表）、reconcile:handle（人工处理/重试补结算）。
 * 角色差异：OPERATOR 可直接处理（E）；FINANCE 可处理（P，A6.5 起走审批）；SUPPORT/AUDITOR 只读。
 */

import { Router } from 'express';
import { z } from 'zod';
import { adminReconService, DIFF_TYPES } from '../../services/admin-recon.service';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { asyncHandler } from '../../lib/async-handler';
import { sendPaginated, sendSuccess } from '../../lib/response';

const router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  diffType: z.enum(['PAID_LOCAL_PENDING', 'PAID_LOCAL_UNKNOWN', 'AMOUNT_MISMATCH', 'DUPLICATE_NOTIFY']).optional(),
  action: z.enum(['AUTO_SETTLED', 'MANUAL_DONE', 'ESCALATED', 'IGNORED']).optional(),
  channel: z.enum(['WECHAT', 'ALIPAY']).optional(),
  orderNo: z.string().max(64).optional(),
  pendingOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/** GET /reconciliations —— 差异列表（附按类型分组计数） */
router.get(
  '/',
  rbac('reconcile:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const query = listQuery.parse(req.query);
    const { items, total, groupCounts } = await adminReconService.listReconciliations(query);
    sendPaginated(res, items, {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    }, { groupCounts });
  })
);

/** GET /reconciliations/meta —— 差异类型字典（前端分组筛选用） */
router.get(
  '/meta',
  rbac('reconcile:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, { diffTypes: Object.values(DIFF_TYPES) });
  })
);

/** GET /reconciliations/:id —— 差异详情（须在 /meta 之后注册） */
router.get(
  '/:id',
  rbac('reconcile:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    sendSuccess(res, await adminReconService.getReconciliation(req.params.id!));
  })
);

const handleSchema = z.object({
  action: z.enum(['MANUAL_DONE', 'ESCALATED', 'IGNORED']),
  note: z.string().min(2).max(500),
});

/** POST /reconciliations/:id/handle —— 人工处理（不改资金，仅标记工单） */
router.post(
  '/:id/handle',
  rbac('reconcile:handle'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = handleSchema.parse(req.body);
    const result = await adminReconService.handleReconciliation(
      req.params.id!,
      data.action,
      data.note,
      req.admin!.id,
      req.requestId
    );
    sendSuccess(res, result);
  })
);

/** POST /reconciliations/:id/resettle —— 重试补结算（仅"渠道已付本地未结"，幂等不重复发权益） */
router.post(
  '/:id/resettle',
  rbac('reconcile:handle'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const result = await adminReconService.retrySettlement(
      req.params.id!,
      req.admin!.id,
      req.requestId
    );
    sendSuccess(res, result);
  })
);

export default router;

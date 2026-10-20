/**
 * 运营后台·用户管理（/api/admin/v1/users）
 * 权限：user:read（列表/详情/重算）、user:disable（禁用/启用）、session:revoke（强制下线）。
 * 设计见 plans/运营后台管理系统设计.md 6.2 路由清单。
 */

import { Router } from 'express';
import { z } from 'zod';
import { adminUserMgmtService } from '../../services/admin-user-mgmt.service';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { asyncHandler } from '../../lib/async-handler';
import { sendPaginated, sendSuccess } from '../../lib/response';
import { ValidationError } from '../../lib/errors';

const router = Router();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(64).optional(),
  planId: z.string().max(32).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
});

/** GET /users —— 列表（搜索/套餐/状态/注册时间区间） */
router.get(
  '/',
  rbac('user:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const query = listQuery.parse(req.query);
    const { items, total } = await adminUserMgmtService.listUsers(query);
    sendPaginated(res, items, {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    });
  })
);

/** GET /users/:id —— 详情（积分账户 / 活跃会话数 / 订单摘要） */
router.get(
  '/:id',
  rbac('user:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const detail = await adminUserMgmtService.getUserDetail(req.params.id!);
    sendSuccess(res, detail);
  })
);

const statusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reason: z.string().min(2).max(200),
});

/** POST /users/:id/status —— 禁用/启用（禁用自动吊销全部会话） */
router.post(
  '/:id/status',
  rbac('user:disable'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = statusSchema.parse(req.body);
    const result = await adminUserMgmtService.setUserStatus(
      req.params.id!,
      data.status,
      req.admin!.id,
      data.reason,
      req.requestId
    );
    sendSuccess(res, result);
  })
);

/** POST /users/:id/sessions/revoke —— 强制下线（吊销全部会话） */
router.post(
  '/:id/sessions/revoke',
  rbac('session:revoke'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const count = await adminUserMgmtService.revokeUserSessions(
      req.params.id!,
      req.admin!.id,
      req.requestId
    );
    sendSuccess(res, { revokedSessions: count });
  })
);

/** GET /users/:id/ledger/recompute —— 账本重算校验（只读） */
router.get(
  '/:id/ledger/recompute',
  rbac('credit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const result = await adminUserMgmtService.recomputeLedger(req.params.id!);
    sendSuccess(res, result);
  })
);

export default router;

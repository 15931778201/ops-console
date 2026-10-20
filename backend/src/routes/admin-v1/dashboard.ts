/**
 * 运营后台·仪表盘路由（A6.7）
 * 权限：dashboard:read（五角色全有）。
 *
 * 关键约束：GET 只读 snapshot 表，不实时 COUNT 大表。
 * 手动刷新是独立 POST，避免误触导致每次看页面都压库。
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { sendSuccess } from '../../lib/response';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { dashboardService, SCOPES } from '../../services/dashboard.service';
import { audit } from '../../lib/audit';

const router = Router();

/** GET /dashboard/meta —— scope 字典与异常跳转配置 */
router.get(
  '/meta',
  rbac('dashboard:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, dashboardService.meta());
  })
);

/** GET /dashboard?scope=today|d7|d30 —— 读指标快照 */
router.get(
  '/',
  rbac('dashboard:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const scope = z.enum(SCOPES).default('today').parse(req.query.scope);
    sendSuccess(res, await dashboardService.read(scope));
  })
);

/** POST /dashboard/refresh —— 手动触发重算（运营偶尔需要立刻看最新数字） */
router.post(
  '/refresh',
  rbac('dashboard:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const scope = z.enum(SCOPES).default('today').parse(req.body?.scope);
    const view = await dashboardService.refreshNow(scope);
    await audit.record({
      actorType: 'ADMIN',
      actorId: req.admin!.id,
      action: 'dashboard.refreshed',
      targetType: 'system',
      targetId: 'dashboard',
      metadata: { scope },
      requestId: req.requestId,
    });
    sendSuccess(res, view);
  })
);

export default router;
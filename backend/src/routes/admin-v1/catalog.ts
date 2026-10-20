/**
 * 运营后台·套餐/规则/邀请路由（A6.7）
 * 权限：读plan:read / rule:read / invite:read；写 plan:write / rule:write。
 *
 * 注：改价与上下架按设计文档 M5 应走审批流；当前直接开放给plan:write，
 * OPERATOR 与 SUPER_ADMIN 持有该权限码。待审批类型PLAN_CHANGE 落地后可切换。
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { sendSuccess, sendPaginated } from '../../lib/response';
import { rbac, rbacAny } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { adminCatalogService } from '../../services/admin-catalog.service';

const router = Router();

// ==================== 套餐 ====================

/** GET /catalog/plans —— 套餐列表（含持有者数） */
router.get(
  '/plans',
  rbacAny(['plan:read', 'plan:write']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const activeOnly = req.query.activeOnly === 'true';
    sendSuccess(res, { items: await adminCatalogService.listPlans({ activeOnly }) });
  })
);

/** GET /catalog/plans/:id —— 套餐详情（含价格历史） */
router.get(
  '/plans/:id',
  rbacAny(['plan:read', 'plan:write']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    sendSuccess(res, await adminCatalogService.getPlan(req.params.id!));
  })
);

const updatePlanSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  monthlyCredits: z.number().int().min(0).max(10_000_000).optional(),
  priceCents: z.number().int().min(0).max(100_000_00).optional(),
  maxFiles: z.number().int().min(1).max(1000).optional(),
  costTierAccess: z.array(z.string().max(30)).max(20).optional(),
  reason: z.string().min(2).max(500),
});

/** PATCH /catalog/plans/:id —— 改价/改积分（自动写入价格历史） */
router.patch(
  '/plans/:id',
  rbac('plan:write'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = updatePlanSchema.parse(req.body);
    sendSuccess(res, await adminCatalogService.updatePlan(req.params.id!, data, req.admin!.id));
  })
);

/** POST /catalog/plans/:id/active —— 上下架 */
router.post(
  '/plans/:id/active',
  rbac('plan:write'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const { active, reason } = z
      .object({ active: z.boolean(), reason: z.string().min(2).max(500) })
      .parse(req.body);
    sendSuccess(
      res,
      await adminCatalogService.setPlanActive(req.params.id!, active, reason, req.admin!.id)
    );
  })
);

/** GET /catalog/plans/:id/impact —— 改价影响预览（只读） */
router.get(
  '/plans/:id/impact',
  rbacAny(['plan:read', 'plan:write']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const raw = req.query.newPriceCents;
    const newPriceCents = typeof raw === 'string' && raw !== '' ? Number(raw) : undefined;
    sendSuccess(res, await adminCatalogService.previewPlanImpact(req.params.id!, newPriceCents));
  })
);

// ==================== 工具计费规则 ====================

/** GET /catalog/rules —— 计费规则列表（含近 7 日用量） */
router.get(
  '/rules',
  rbacAny(['rule:read', 'rule:write']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const activeOnly = req.query.activeOnly === 'true';
    sendSuccess(res, { items: await adminCatalogService.listRules({ activeOnly }) });
  })
);

const updateRuleSchema = z.object({
  creditCost: z.number().int().min(0).max(100_000).optional(),
  minPlan: z.string().min(1).max(40).optional(),
  maxFilesPerTask: z.number().int().min(1).max(1000).optional(),
  active: z.boolean().optional(),
  reason: z.string().min(2).max(500),
});

/** PATCH /catalog/rules/:toolSlug —— 改规则（ruleVersion 自动递增） */
router.patch(
  '/rules/:toolSlug',
  rbac('rule:write'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = updateRuleSchema.parse(req.body);
    sendSuccess(
      res,
      await adminCatalogService.updateRule(req.params.toolSlug!, data, req.admin!.id)
    );
  })
);

/** GET /catalog/rules/:toolSlug/impact —— 调价影响预览（只读） */
router.get(
  '/rules/:toolSlug/impact',
  rbacAny(['rule:read', 'rule:write']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const raw = req.query.newCreditCost;
    const newCreditCost = Number(raw);
    sendSuccess(res, await adminCatalogService.previewRuleImpact(req.params.toolSlug!, newCreditCost));
  })
);

// ==================== 邀请与归因 ====================

/** GET /catalog/invites/codes —— 邀请码列表 */
router.get(
  '/invites/codes',
  rbac('invite:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        activeOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const result = await adminCatalogService.listInviteCodes({
      page: q.page,
      pageSize: q.pageSize,
      activeOnly: q.activeOnly,
    });
    sendPaginated(res, result.items, {
      page: q.page,
      pageSize: q.pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
    });
  })
);

/** GET /catalog/invites/relations —— 归因关系列表 */
router.get(
  '/invites/relations',
  rbac('invite:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        riskFlag: z.string().max(40).optional(),
      })
      .parse(req.query);
    const result = await adminCatalogService.listInviteRelations({
      page: q.page,
      pageSize: q.pageSize,
      riskFlag: q.riskFlag,
    });
    sendPaginated(res, result.items, {
      page: q.page,
      pageSize: q.pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
    });
  })
);

/** GET /catalog/invites/stats —— 邀请统计 */
router.get(
  '/invites/stats',
  rbac('invite:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, await adminCatalogService.inviteStats());
  })
);

export default router;
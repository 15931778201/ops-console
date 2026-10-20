/**
 * 运营后台·审批流路由（/api/admin/v1/approvals）
 *
 * 权限：
 *  - POST /          提交申请（各模块 :apply 权限码）
 *  - GET /           列表（按角色过滤；待我审批）
 *  - GET /mine-count 待办数量（顶栏角标）
 *  - GET /:id        详情
 *  - POST /:id/approve 批准（APPROVAL_AUTHORITY 矩阵）
 *  - POST /:id/reject  拒绝（必填原因）
 *  - POST /:id/cancel  撤回（仅申请人，PENDING）
 *  - POST /:id/execute 执行（已批准；幂等，防重复入账）
 *
 * 契约见 plans/运营后台管理系统设计.md 6.2。
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  approvalService,
  APPROVAL_TYPES,
  APPROVAL_TYPE_LABELS,
  MAX_ADJUST_ABS,
  previewCreditAdjust,
  validateCreditAdjustPayload,
} from '../../services/approval.service';
import { rbac, rbacAny } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { asyncHandler } from '../../lib/async-handler';
import { sendPaginated, sendSuccess } from '../../lib/response';
import type { ApprovalType } from '@prisma/client';

const router = Router();

const typeEnum = z.enum(
  APPROVAL_TYPES as [ApprovalType, ...ApprovalType[]]
);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: typeEnum.optional(),
  status: z
    .enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED'])
    .optional(),
  applicantId: z.string().max(64).optional(),
  approverId: z.string().max(64).optional(),
  mine: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/** GET /approvals —— 列表 */
router.get(
  '/',
  rbacAny(['approval:read', 'credit:adjust:apply', 'credit:adjust:execute', 'reconcile:handle']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const query = listQuery.parse(req.query);
    const { items, total } = await approvalService.list(query, req.admin!);
    sendPaginated(res, items, {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    });
  })
);

/** GET /approvals/mine-count —— 我的待办数量（顶栏角标） */
router.get(
  '/mine-count',
  rbacAny(['approval:read', 'credit:adjust:apply', 'credit:adjust:execute', 'reconcile:handle']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const count = await approvalService.pendingCountFor(req.admin!);
    sendSuccess(res, { pendingCount: count });
  })
);

const creditAdjustSchema = z.object({
  type: z.literal('CREDIT_ADJUST'),
  payload: z.object({
    userId: z.string().min(1).max(64),
    deltaBalance: z.number().int(),
    deltaBonus: z.number().int(),
    reason: z.string().min(2).max(500),
  }),
  reason: z.string().min(2).max(500),
  ticketNo: z.string().max(64).optional(),
});

const submitSchema = creditAdjustSchema;

/** POST /approvals —— 提交申请 */
router.post(
  '/',
  rbac('credit:adjust:apply'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = submitSchema.parse(req.body);
    const result = await approvalService.submit(
      { type: data.type, payload: data.payload, reason: data.reason, ticketNo: data.ticketNo },
      req.admin!.id,
      { requestId: req.requestId, ip: req.ip }
    );
    sendSuccess(res, result, 201);
  })
);

/** POST /approvals/preview —— 调账影响预览（提交前给前端弹窗展示） */
router.post(
  '/preview',
  rbac('credit:adjust:apply'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = z
      .object({
        userId: z.string().min(1).max(64),
        deltaBalance: z.number().int(),
        deltaBonus: z.number().int(),
        reason: z.string().min(2).max(500),
      })
      .parse(req.body);
    const check = validateCreditAdjustPayload(data);
    if (!check.ok) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: `调账参数不合法：${check.problems.join('；')}`,
          details: check.problems.map((message) => ({ path: 'payload', message })),
        },
      });
      return;
    }
    const preview = await previewCreditAdjust(data);
    sendSuccess(res, { ...preview, maxAbs: MAX_ADJUST_ABS });
  })
);

/** GET /approvals/meta/types —— 类型字典（前端筛选用） */
router.get(
  '/meta/types',
  rbacAny(['approval:read', 'credit:adjust:apply', 'credit:adjust:execute']),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, {
      types: APPROVAL_TYPES.map((t) => ({ value: t, label: APPROVAL_TYPE_LABELS[t] })),
    });
  })
);

/** GET /approvals/:id —— 详情 */
router.get(
  '/:id',
  rbacAny(['approval:read', 'credit:adjust:apply', 'credit:adjust:execute', 'reconcile:handle']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const detail = await approvalService.get(req.params.id!);
    sendSuccess(res, detail);
  })
);

/**
 * POST /approvals/:id/approve —— 批准并由服务端同事务执行
 *
 * 设计文档第 77 行：「批准后由系统在同一事务内执行，审批人无需也无法手动代劳执行」。
 * 故此处 approve 后紧接着调用 execute；若执行失败，execute 已把状态置 FAILED，
 * 由 /execute 端点排查后重试（状态机守卫保证不重复入账）。
 */
router.post(
  '/:id/approve',
  rbacAny(['credit:adjust:execute', 'plan:write', 'rule:write']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const approved = await approvalService.approve(
      req.params.id!,
      req.admin!.id,
      req.admin!.role,
      { requestId: req.requestId }
    );
    // 未接入执行模块的类型（如 RULE_CHANGE 待A6.7）保持 APPROVED，交由对应模块处理
    if (approved.status !== 'APPROVED') {
      sendSuccess(res, approved);
      return;
    }
    try {
      const executed = await approvalService.execute(req.params.id!, req.admin!.id, {
        requestId: req.requestId,
      });
      sendSuccess(res, executed);
    } catch {
      // execute 内部已置 FAILED 并写审计；返回 FAILED 视图而非 500，
      // 让前端明确展示"已批准但执行失败，可重试"
      const failed = await approvalService.get(req.params.id!);
      sendSuccess(res, failed);
    }
  })
);

/** POST /approvals/:id/reject —— 拒绝 */
router.post(
  '/:id/reject',
  rbacAny(['credit:adjust:execute', 'plan:write', 'rule:write']),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = z.object({ reason: z.string().min(2).max(500) }).parse(req.body);
    const result = await approvalService.reject(
      req.params.id!,
      req.admin!.id,
      req.admin!.role,
      data.reason,
      { requestId: req.requestId }
    );
    sendSuccess(res, result);
  })
);

/** POST /approvals/:id/cancel —— 撤回（仅申请人） */
router.post(
  '/:id/cancel',
  rbac('credit:adjust:apply'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const result = await approvalService.cancel(req.params.id!, req.admin!.id, {
      requestId: req.requestId,
    });
    sendSuccess(res, result);
  })
);

/**
 * POST /approvals/:id/execute —— 重试执行（仅 FAILED 状态；幂等）
 * 正常路径是 /approve 批准即执行；此端点用于执行失败后的排查重试。
 */
router.post(
  '/:id/execute',
  rbac('credit:adjust:execute'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const result = await approvalService.execute(req.params.id!, req.admin!.id, {
      requestId: req.requestId,
    });
    sendSuccess(res, result);
  })
);

export default router;
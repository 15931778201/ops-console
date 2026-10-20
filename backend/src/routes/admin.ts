/**
 * 运营后台旧通道路由（收敛中）
 * 权限：adminMiddleware（ADMIN_USER_IDS 环境变量白名单，仅作 break-glass 紧急通道）。
 * 新体系见 routes/admin-v1（RBAC + MFA + 双人复核审批）。
 *
 * ⚠️ 安全决策（设计文档 2.2/上线顺序）：A6.5 审批流上线前，单人可直接调账的
 * /adjust-credits 保持关闭——调账必须走"申请→审批→服务端执行"双人复核。
 */

import { Router } from 'express';
import { z } from 'zod';
import { adminMiddleware, type AuthRequest } from '../middleware/auth';
import { approvalGuard } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { asyncHandler } from '../lib/async-handler';
import { sendSuccess, sendPaginated } from '../lib/response';
import type { OrderStatus } from '@prisma/client';

const router = Router();

router.use(adminMiddleware);

/** GET /api/admin/users */
router.get('/users', asyncHandler(async (req: AuthRequest, res) => {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().max(64).optional(),
    })
    .parse(req.query);

  const where = query.search
    ? {
        OR: [
          { email: { contains: query.search } },
          { phone: { contains: query.search } },
          { name: { contains: query.search } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        planId: true,
        planExpiresAt: true,
        status: true,
        createdAt: true,
        creditAccount: { select: { balance: true, bonusBalance: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  sendPaginated(res, users, {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  });
}));

/** GET /api/admin/orders */
router.get('/orders', asyncHandler(async (req: AuthRequest, res) => {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(['PENDING', 'PAID', 'FAILED', 'REFUNDING', 'REFUNDED', 'CLOSED']).optional(),
    })
    .parse(req.query);

  const where = query.status ? { status: query.status as OrderStatus } : {};

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { user: { select: { id: true, email: true, phone: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  sendPaginated(res, orders, {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  });
}));

/**
 * POST /api/admin/adjust-credits
 *
 * 历史沿革：A6.1 因"申请与审批分离"红线关闭；A6.5 审批流落地后，
 * 该入口改为**带审批守卫的兼容通道**，供旧前端平滑迁移——
 * 仍必须提供已批准的 CREDIT_ADJUST 审批单号，否则 403 ADMIN_APPROVAL_REQUIRED。
 *
 * 新前端应直接使用 /api/admin/v1/approvals 的完整流程
 * （申请 → 审批 → 执行），此端点仅为兼容保留。
 */
router.post(
  '/adjust-credits',
  approvalGuard('CREDIT_ADJUST'),
  asyncHandler(async (req: AuthRequest, res) => {
    // approvalGuard 已校验审批单为 APPROVED；此处只做参数透传与结果返回。
    // 真正的执行动作由 /api/admin/v1/approvals/:id/execute 承担，
    // 故这里仅返回引导信息，避免出现"绕过审批流直接入账"的第二条路径。
    const approval = (req as AuthRequest & { approval?: { id: string; status: string } }).approval;
    sendSuccess(res, {
      approvalId: approval?.id,
      next: `POST /api/admin/v1/approvals/${approval?.id}/execute`,
      message: '审批已通过：请调用执行端点完成调账（服务端幂等，不会重复入账）',
    });
  })
);

/** GET /api/admin/audit-logs —— 审计日志查询 */
router.get('/audit-logs', asyncHandler(async (req: AuthRequest, res) => {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      action: z.string().max(64).optional(),
      actorId: z.string().max(64).optional(),
    })
    .parse(req.query);

  const where: Record<string, unknown> = {};
  if (query.action) where.action = query.action;
  if (query.actorId) where.actorId = query.actorId;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  sendPaginated(res, logs, {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  });
}));

export default router;

/**
 * RBAC 中间件
 * 按权限码（`资源:动作`）校验；SUPPORT/AUDITOR 零写权限由矩阵保证。
 * 用法：router.post('/x', rbac('user:disable'), handler)
 *       router.get('/y', rbacAny(['audit:read', 'audit:export']), handler)
 */

import type { RequestHandler } from 'express';
import { sendError } from '../lib/response';
import { AdminError, ErrorCode } from '../lib/errors';
import type { Permission } from '../lib/admin-permissions';
import type { AdminAuthRequest } from './admin-auth';
import type { ApprovalType } from '@prisma/client';
import { approvalService } from '../services/approval.service';

/** 单个权限码校验 */
export function rbac(required: Permission): RequestHandler {
  return (req: AdminAuthRequest, res, next) => {
    if (!req.admin) {
      sendError(
        res,
        new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '未登录', 401),
        'rbac_middleware'
      );
      return;
    }
    if (!req.admin.permissions.includes(required)) {
      sendError(
        res,
        new AdminError(ErrorCode.ADMIN_PERMISSION_DENIED, '权限不足', 403),
        'rbac_middleware'
      );
      return;
    }
    next();
  };
}

/** 任一权限码命中即放行 */
export function rbacAny(codes: Permission[]): RequestHandler {
  return (req: AdminAuthRequest, res, next) => {
    if (!req.admin) {
      sendError(
        res,
        new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '未登录', 401),
        'rbac_middleware'
      );
      return;
    }
    if (!codes.some((code) => req.admin!.permissions.includes(code))) {
      sendError(
        res,
        new AdminError(ErrorCode.ADMIN_PERMISSION_DENIED, '权限不足', 403),
        'rbac_middleware'
      );
      return;
    }
    next();
  };
}

/**
 * approvalGuard —— 审批守卫（A6.5 落地）
 *
 * 设计：handler 声明所需审批类型 → 请求体带 approvalId 且状态为 APPROVED 才放行执行；
 * 否则抛 ADMIN_APPROVAL_REQUIRED，前端转为"提交申请"表单。
 *
 * 语义边界：
 * - 守卫只验证"审批单存在、类型匹配、已批准、审批人≠申请人"；
 * - **执行仍走审批流自己的 execute 端点**，守卫不替代状态机。
 * - 用途：让"单人直达写操作"在 A6.5 之后也能被同一套规则拦截
 *   （例如直接调用某个执行型接口时忘了带 approvalId）。
 */
export function approvalGuard(expectedType: ApprovalType): RequestHandler {
  return async (req: AdminAuthRequest, res, next) => {
    if (!req.admin) {
      sendError(
        res,
        new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '未登录', 401),
        'approval_guard'
      );
      return;
    }
    const body = req.body as { approvalId?: unknown } | undefined;
    const approvalId = typeof body?.approvalId === 'string' ? body.approvalId : null;

    if (!approvalId) {
      sendError(
        res,
        new AdminError(
          ErrorCode.ADMIN_APPROVAL_REQUIRED,
          '该操作需要审批通过后才能执行（请先提交申请）',
          403
        ),
        'approval_guard'
      );
      return;
    }

    try {
      const approval = await approvalService.get(approvalId);
      if (approval.type !== expectedType) {
        sendError(
          res,
          new AdminError(ErrorCode.ADMIN_PERMISSION_DENIED, '审批单类型不匹配', 403),
          'approval_guard'
        );
        return;
      }
      if (approval.status !== 'APPROVED') {
        sendError(
          res,
          new AdminError(
            ErrorCode.ADMIN_APPROVAL_REQUIRED,
            `审批单当前状态为 ${approval.status}，需已批准`,
            403
          ),
          'approval_guard'
        );
        return;
      }
      if (approval.applicantId === req.admin.id) {
        sendError(
          res,
          new AdminError(ErrorCode.ADMIN_APPROVAL_CONFLICT, '申请人不能执行自己的审批单', 409),
          'approval_guard'
        );
        return;
      }
      // 通过：把审批上下文挂到请求上，供 handler 使用
      (req as AdminAuthRequest & { approval?: typeof approval }).approval = approval;
      next();
    } catch (err) {
      next(err);
    }
  };
}

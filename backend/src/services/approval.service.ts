/**
 * 运营后台·审批流服务（A6.5）
 *
 * 双人复核核心：能改的不能批，资金/批量操作必须两人。
 * 流程：
 *   submit → PENDING → approve(批准) → APPROVED → execute(执行) → EXECUTED
 *                      ↘ reject(拒绝)  → REJECTED（留痕，结束）
 *   PENDING 状态申请人可 cancel
 *
 * 服务端强制规则（全部在此层校验，路由层只做参数解析）：
 *  1. 申请人 ≠ 审批人（同一个账号既是申请人又是审批人时禁止批准）
 *  2. 审批权限按类型分流：APPROVAL_AUTHORITY 矩阵，RULE_CHANGE 仅 SUPER_ADMIN
 *  3. CREDIT_ADJUST 单笔上限 ±100,000，超限需 SUPER_ADMIN 审批
 *  4. CREDIT_ADJUST 24 小时内对同一用户最多 3 笔（防刷）
 *  5. 执行只做一次（EXECUTED/FAILED 不再执行）；执行失败置 FAILED 可重试
 *  6. 执行与流水写入同事务（adjust + ApprovalRequest(EXECUTED) + AuditLog）
 *
 * 设计见 plans/运营后台管理系统设计.md M4。
 */

import type { ApprovalStatus, ApprovalType, Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { ledgerService } from './ledger.service';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { AdminError, ErrorCode, ValidationError } from '../lib/errors';
import { canApprove } from '../lib/admin-permissions';
import type { AdminRole } from '@prisma/client';

export const APPROVAL_TYPES: ApprovalType[] = [
  'CREDIT_ADJUST',
  'REFUND',
  'ORDER_CLOSE',
  'PLAN_CHANGE',
  'RULE_CHANGE',
  'INVITE_REWARD',
];

export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  CREDIT_ADJUST: '积分调账',
  REFUND: '订单退款',
  ORDER_CLOSE: '强制关单',
  PLAN_CHANGE: '套餐变更',
  RULE_CHANGE: '计费规则变更',
  INVITE_REWARD: '邀请奖励',
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: '待审批',
  APPROVED: '已批准待执行',
  REJECTED: '已拒绝',
  EXECUTED: '已执行',
  FAILED: '执行失败',
  CANCELLED: '已撤回',
};

/** 单笔调账上限（积分）；超限需 SUPER_ADMIN 审批 */
export const MAX_ADJUST_ABS = 100_000;

/** 同一用户 24 小时内调账笔数上限（防刷） */
export const MAX_ADJUST_PER_24H = 3;

// ---------- payload 类型 ----------

export interface CreditAdjustPayload {
  userId: string;
  deltaBalance: number;
  deltaBonus: number;
  /** 申请人填写的说明（执行时会拼进流水 description） */
  reason: string;
}

/** 校验 payload 形状；不合法返回问题列表（空数组 = 合法） */
export function validateCreditAdjustPayload(payload: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const p = payload as Partial<CreditAdjustPayload> | null;
  if (!p || typeof p !== 'object') {
    return { ok: false, problems: ['payload 必须为对象'] };
  }
  if (typeof p.userId !== 'string' || p.userId.length === 0) problems.push('userId 必填');
  if (typeof p.deltaBalance !== 'number' || !Number.isInteger(p.deltaBalance)) {
    problems.push('deltaBalance 必须为整数');
  }
  if (typeof p.deltaBonus !== 'number' || !Number.isInteger(p.deltaBonus)) {
    problems.push('deltaBonus 必须为整数');
  }
  if ((p.deltaBalance ?? 0) === 0 && (p.deltaBonus ?? 0) === 0) {
    problems.push('deltaBalance 与 deltaBonus 不能同时为 0');
  }
  if (Math.abs(p.deltaBalance ?? 0) > MAX_ADJUST_ABS || Math.abs(p.deltaBonus ?? 0) > MAX_ADJUST_ABS) {
    problems.push(`单笔调整绝对值不得超过 ${MAX_ADJUST_ABS}`);
  }
  if (typeof p.reason !== 'string' || p.reason.trim().length < 2) {
    problems.push('调账原因至少 2 个字符');
  }
  return { ok: problems.length === 0, problems };
}

/** 影响预览：当前余额 + 调整后余额（前端弹窗展示用） */
export async function previewCreditAdjust(payload: CreditAdjustPayload): Promise<{
  currentBalance: number;
  currentBonus: number;
  afterBalance: number;
  afterBonus: number;
  /** 调整后是否出现负值（后端也会拦，这里先给前端提示） */
  wouldGoNegative: boolean;
  /** 是否触发 SUPER_ADMIN 审批门槛 */
  requiresSuperAdmin: boolean;
  /** 该用户 24h 内已提交的调账笔数 */
  recentCount: number;
}> {
  const account = await prisma.creditAccount.findUnique({
    where: { userId: payload.userId },
    select: { balance: true, bonusBalance: true },
  });
  const currentBalance = account?.balance ?? 0;
  const currentBonus = account?.bonusBalance ?? 0;
  const afterBalance = currentBalance + payload.deltaBalance;
  const afterBonus = currentBonus + payload.deltaBonus;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const recentCount = await prisma.approvalRequest.count({
    where: {
      type: 'CREDIT_ADJUST',
      createdAt: { gte: since },
      status: { not: 'CANCELLED' },
      payload: { path: ['userId'], equals: payload.userId },
    },
  });

  return {
    currentBalance,
    currentBonus,
    afterBalance,
    afterBonus,
    wouldGoNegative: afterBalance < 0 || afterBonus < 0,
    requiresSuperAdmin:
      Math.abs(payload.deltaBalance) > MAX_ADJUST_ABS || Math.abs(payload.deltaBonus) > MAX_ADJUST_ABS,
    recentCount,
  };
}

function toView(r: Prisma.ApprovalRequestGetPayload<Record<string, never>>) {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    payload: r.payload,
    reason: r.reason,
    ticketNo: r.ticketNo,
    applicantId: r.applicantId,
    approverId: r.approverId,
    approvedAt: r.approvedAt,
    executedAt: r.executedAt,
    result: r.result,
    createdAt: r.createdAt,
  };
}

type ApprovalView = ReturnType<typeof toView>;

export interface ApprovalListQuery {
  page: number;
  pageSize: number;
  type?: ApprovalType;
  status?: ApprovalStatus;
  applicantId?: string;
  approverId?: string;
  /** 我的待办：类型 × 当前角色可批 + 状态 PENDING/APPROVED */
  mine?: boolean;
}

export interface SubmitApprovalInput {
  type: ApprovalType;
  payload: unknown;
  reason: string;
  ticketNo?: string;
}

export const approvalService = {
  /**
   * 提交申请（任何持对应 `*:apply` 权限码的管理员）。
   * 校验按类型分派；CREDIT_ADJUST 走 payload 形状校验 + 频控。
   */
  async submit(
    input: SubmitApprovalInput,
    applicantId: string,
    context: { requestId?: string; ip?: string } = {}
  ): Promise<ApprovalView> {
    if (!APPROVAL_TYPES.includes(input.type)) {
      throw new ValidationError('不支持的审批类型');
    }
    if (!input.reason || input.reason.trim().length < 2) {
      throw new ValidationError('申请原因至少 2 个字符');
    }

    if (input.type === 'CREDIT_ADJUST') {
      const check = validateCreditAdjustPayload(input.payload);
      if (!check.ok) {
        throw new ValidationError(`调账参数不合法：${check.problems.join('；')}`);
      }
      const p = input.payload as CreditAdjustPayload;
      // 24h 频控：同一用户最多 3 笔（含已撤回？不含，撤回说明没生效）
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const recent = await prisma.approvalRequest.count({
        where: {
          type: 'CREDIT_ADJUST',
          createdAt: { gte: since },
          status: { not: 'CANCELLED' },
          payload: { path: ['userId'], equals: p.userId },
        },
      });
      if (recent >= MAX_ADJUST_PER_24H) {
        throw new AdminError(
          ErrorCode.ADMIN_APPROVAL_CONFLICT,
          `该用户 24 小时内调账申请已达上限 ${MAX_ADJUST_PER_24H} 笔，请勿拆分刷单`,
          409
        );
      }
    }

    const created = await prisma.approvalRequest.create({
      data: {
        type: input.type,
        payload: input.payload as Prisma.InputJsonValue,
        reason: input.reason.trim(),
        ticketNo: input.ticketNo?.trim() || null,
        applicantId,
        status: 'PENDING',
      },
    });

    await audit.record({
      actorType: 'ADMIN',
      actorId: applicantId,
      action: 'approval.submitted',
      targetType: 'ApprovalRequest',
      targetId: created.id,
      reason: created.reason,
      metadata: { type: created.type, ticketNo: created.ticketNo },
      requestId: context.requestId,
    });
    logger.info({ applicantId, approvalId: created.id, type: created.type }, 'approval_submitted');
    return toView(created);
  },

  /** 列表：支持按申请人/审批人/类型/状态筛选；mine=true 只看当前角色可批的待办 */
  async list(
    query: ApprovalListQuery,
    viewer: { id: string; role: AdminRole }
  ): Promise<{ items: ApprovalView[]; total: number }> {
    const where: Prisma.ApprovalRequestWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.applicantId) where.applicantId = query.applicantId;
    if (query.approverId) where.approverId = query.approverId;
    if (query.mine) {
      where.status = { in: ['PENDING', 'APPROVED'] };
      // 申请人自己提交的不能出现在"待我审批"
      where.applicantId = { not: viewer.id };
      const types = APPROVAL_TYPES.filter((t) => canApprove(viewer.role, t));
      where.type = { in: types };
    }

    const [items, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.approvalRequest.count({ where }),
    ]);
    return { items: items.map(toView), total };
  },

  async get(id: string): Promise<ApprovalView> {
    const r = await prisma.approvalRequest.findUnique({ where: { id } });
    if (!r) throw new ValidationError('审批单不存在');
    return toView(r);
  },

  /**
   * 批准。校验：
   *  - 状态必须 PENDING
   *  - 审批人 ≠ 申请人（否则自己批自己）
   *  - 审批人按类型在 APPROVAL_AUTHORITY 矩阵内
   */
  async approve(
    id: string,
    approverId: string,
    approverRole: AdminRole,
    context: { requestId?: string } = {}
  ): Promise<ApprovalView> {
    const r = await prisma.approvalRequest.findUnique({ where: { id } });
    if (!r) throw new ValidationError('审批单不存在');
    if (r.status !== 'PENDING') {
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        `当前状态为 ${APPROVAL_STATUS_LABELS[r.status]}，无法批准`,
        409
      );
    }
    if (r.applicantId === approverId) {
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        '申请人不能审批自己的申请（双人复核）',
        409
      );
    }
    if (!canApprove(approverRole, r.type)) {
      throw new AdminError(
        ErrorCode.ADMIN_PERMISSION_DENIED,
        `你的角色无权审批${APPROVAL_TYPE_LABELS[r.type]}`,
        403
      );
    }

    const updated = await prisma.approvalRequest.update({
      where: { id },
      data: { status: 'APPROVED', approverId, approvedAt: new Date() },
    });

    await audit.record({
      actorType: 'ADMIN',
      actorId: approverId,
      action: 'approval.approved',
      targetType: 'ApprovalRequest',
      targetId: id,
      reason: r.reason,
      metadata: { type: r.type },
      requestId: context.requestId,
    });
    logger.info({ approverId, approvalId: id }, 'approval_approved');
    return toView(updated);
  },

  /** 拒绝（必须填原因，留痕） */
  async reject(
    id: string,
    approverId: string,
    approverRole: AdminRole,
    reason: string,
    context: { requestId?: string } = {}
  ): Promise<ApprovalView> {
    if (!reason || reason.trim().length < 2) {
      throw new ValidationError('拒绝原因至少 2 个字符');
    }
    const r = await prisma.approvalRequest.findUnique({ where: { id } });
    if (!r) throw new ValidationError('审批单不存在');
    if (r.status !== 'PENDING') {
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        `当前状态为 ${APPROVAL_STATUS_LABELS[r.status]}，无法拒绝`,
        409
      );
    }
    if (r.applicantId === approverId) {
      throw new AdminError(ErrorCode.ADMIN_APPROVAL_CONFLICT, '申请人不能审批自己的申请', 409);
    }
    if (!canApprove(approverRole, r.type)) {
      throw new AdminError(ErrorCode.ADMIN_PERMISSION_DENIED, '你的角色无权审批该类型', 403);
    }

    const updated = await prisma.approvalRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approverId,
        approvedAt: new Date(),
        result: { rejectedReason: reason.trim() },
      },
    });

    await audit.record({
      actorType: 'ADMIN',
      actorId: approverId,
      action: 'approval.rejected',
      targetType: 'ApprovalRequest',
      targetId: id,
      reason: reason.trim(),
      metadata: { type: r.type },
      requestId: context.requestId,
    });
    return toView(updated);
  },

  /** 申请人撤回（仅 PENDING） */
  async cancel(id: string, applicantId: string, context: { requestId?: string } = {}): Promise<ApprovalView> {
    const r = await prisma.approvalRequest.findUnique({ where: { id } });
    if (!r) throw new ValidationError('审批单不存在');
    if (r.applicantId !== applicantId) {
      throw new AdminError(ErrorCode.ADMIN_PERMISSION_DENIED, '只有申请人可以撤回', 403);
    }
    if (r.status !== 'PENDING') {
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        `当前状态为 ${APPROVAL_STATUS_LABELS[r.status]}，无法撤回`,
        409
      );
    }
    const updated = await prisma.approvalRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    await audit.record({
      actorType: 'ADMIN',
      actorId: applicantId,
      action: 'approval.cancelled',
      targetType: 'ApprovalRequest',
      targetId: id,
      requestId: context.requestId,
    });
    return toView(updated);
  },

  /**
   * 执行（批准后）。
   * - APPROVED 可执行；FAILED 可重试（A6.5 验收："执行失败可重试且不重复入账"）
   * - EXECUTED 绝不重复执行（防重复入账）；PENDING/REJECTED/CANCELLED 不可执行
   * - 当前实现 CREDIT_ADJUST；其他类型在对应模块落地后扩展（显式报错而不是静默成功）
   * - 执行与流水写入同事务
   */
  async execute(
    id: string,
    operatorId: string,
    context: { requestId?: string } = {}
  ): Promise<ApprovalView> {
    const r = await prisma.approvalRequest.findUnique({ where: { id } });
    if (!r) throw new ValidationError('审批单不存在');
    // FAILED 重试的前提：此前已有人批准过（否则等于绕过审批直接执行）
    if (r.status === 'FAILED' && !r.approverId) {
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        '该审批从未被批准，不可直接执行',
        409
      );
    }
    if (r.status !== 'APPROVED' && r.status !== 'FAILED') {
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        r.status === 'EXECUTED'
          ? '该审批已执行过，不可重复执行'
          : `当前状态为 ${APPROVAL_STATUS_LABELS[r.status]}，无法执行`,
        409
      );
    }

    if (r.type !== 'CREDIT_ADJUST') {
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        `${APPROVAL_TYPE_LABELS[r.type]}的执行尚未接入，请等待对应模块上线`,
        409
      );
    }

    const p = r.payload as unknown as CreditAdjustPayload;
    const check = validateCreditAdjustPayload(p);
    if (!check.ok) {
      // 批准后参数被判定不合法（极端情况）：置 FAILED 留痕
      await prisma.approvalRequest.update({
        where: { id },
        data: { status: 'FAILED', result: { error: check.problems.join('；') } },
      });
      throw new ValidationError(`审批参数已不合法：${check.problems.join('；')}`);
    }

    // 执行 + 状态推进同事务：adjust 内部也开事务，但此处需要 approval 状态与流水一致，
    // 故用同一事务传入（ledgerService.adjust 内部用 prisma.$transaction，
    // 嵌套时 Prisma 会合并到外层事务——这里改为显式在同一事务内执行）。
    try {
      await prisma.$transaction(async (tx) => {
        const account = await tx.creditAccount.findUnique({
          where: { userId: p.userId },
          select: { id: true },
        });
        if (!account) throw new ValidationError('目标用户积分账户不存在');

        // 复用 ledgerService 的负值防护：这里直接走 adjust（其内部 $transaction
        // 会与外层事务合并，保证要么都成功要么都回滚）
        await ledgerService.adjust(p.userId, {
          deltaBalance: p.deltaBalance,
          deltaBonus: p.deltaBonus,
          reason: `${r.reason}${r.ticketNo ? `（工单 ${r.ticketNo}）` : ''}`,
          operatorId: r.applicantId,
          // 关键：把审批单 ID 写进流水 referenceId，账本与审批记录双向可追溯
          referenceId: `approval:${r.id}`,
        });

        await tx.approvalRequest.update({
          where: { id },
          data: {
            status: 'EXECUTED',
            executedAt: new Date(),
            result: {
              executedBy: operatorId,
              deltaBalance: p.deltaBalance,
              deltaBonus: p.deltaBonus,
              userId: p.userId,
            },
          },
        });
      });
    } catch (err) {
      // 执行失败：置 FAILED，允许排查后重试（重试仍走完整状态机守卫）
      const message = (err as Error).message?.slice(0, 500) ?? '未知错误';
      await prisma.approvalRequest.update({
        where: { id },
        data: { status: 'FAILED', result: { error: message } },
      });
      logger.error({ err, approvalId: id }, 'approval_execute_failed');
      throw new AdminError(
        ErrorCode.ADMIN_APPROVAL_CONFLICT,
        `执行失败：${message}`,
        409
      );
    }

    await audit.record({
      actorType: 'ADMIN',
      actorId: operatorId,
      action: 'approval.executed',
      targetType: 'ApprovalRequest',
      targetId: id,
      reason: r.reason,
      metadata: {
        type: r.type,
        applicantId: r.applicantId,
        approverId: r.approverId,
        deltaBalance: p.deltaBalance,
        deltaBonus: p.deltaBonus,
      },
      requestId: context.requestId,
    });
    logger.info(
      { operatorId, approvalId: id, userId: p.userId },
      'approval_executed'
    );

    const after = await prisma.approvalRequest.findUnique({ where: { id } });
    return toView(after!);
  },

  /** 我的待办数量（顶栏角标用） */
  async pendingCountFor(viewer: { id: string; role: AdminRole }): Promise<number> {
    const types = APPROVAL_TYPES.filter((t) => canApprove(viewer.role, t));
    if (types.length === 0) return 0;
    return prisma.approvalRequest.count({
      where: {
        status: { in: ['PENDING', 'APPROVED'] },
        applicantId: { not: viewer.id },
        type: { in: types },
      },
    });
  },
};

export default approvalService;
export type { ApprovalView };
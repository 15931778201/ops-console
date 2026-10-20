/**
 * 运营后台·积分账本路由（A6.6）
 * 权限：全部读操作，credit:read即可。**本模块不含任何写库能力**——
 * 调账只能走审批流（POST /approvals），防止绕过双人复核。
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { sendSuccess, sendPaginated } from '../../lib/response';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { adminLedgerService, DISCREPANCY_REASONS } from '../../services/admin-ledger.service';
import { audit } from '../../lib/audit';

const router = Router();

/** GET /ledger/meta —— 类型/状态/不平原因字典 */
router.get(
  '/meta',
  rbac('credit:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, adminLedgerService.meta());
  })
);

/** GET /ledger/transactions —— 全局流水查询 */
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.string().max(64).optional(),
  userSearch: z.string().max(120).optional(),
  type: z.enum(['CONSUME', 'GRANT', 'RESET', 'REFUND', 'ADJUST', 'INVITE_GRANT', 'BONUS']).optional(),
  status: z.enum(['PENDING', 'SETTLED', 'ROLLED_BACK']).optional(),
  toolSlug: z.string().max(64).optional(),
  reference: z.string().max(120).optional(),
  createdFrom: z.string().max(40).optional(),
  createdTo: z.string().max(40).optional(),
});

router.get(
  '/transactions',
  rbac('credit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const q = listQuery.parse(req.query);
    const result = await adminLedgerService.listTransactions(q);
    // summary 与 items 同级（前端一次拿到列表 + 汇总）
    sendPaginated(
      res,
      result.items,
      {
        page: q.page,
        pageSize: q.pageSize,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
      },
      // summary 与 items 同级（前端一次拿到列表 + 汇总）
      { summary: result.summary }
    );
  })
);

/** GET /ledger/accounts/anomalies —— 不平/负值账户列表 */
const anomalyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  reason: z.enum(DISCREPANCY_REASONS).optional(),
});

router.get(
  '/accounts/anomalies',
  rbac('credit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const q = anomalyQuery.parse(req.query);
    const result = await adminLedgerService.listAnomalousAccounts(q);
    sendPaginated(res, result.items, {
      page: q.page,
      pageSize: q.pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
    });
  })
);

/**
 * POST /ledger/accounts/scan —— 手动触发不平扫描（只读，触发告警日志）
 * 单独POST 而非 GET：它是一次"动作"（产生 job 语义与审计），不是查询。
 */
router.post(
  '/accounts/scan',
  rbac('credit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const result = await adminLedgerService.scanAnomalies();
    await audit.record({
      actorType: 'ADMIN',
      actorId: req.admin!.id,
      action: 'ledger.anomaly_scanned',
      targetType: 'system',
      targetId: 'ledger',
      metadata: result as unknown as Record<string, unknown>,
      requestId: req.requestId,
    });
    sendSuccess(res, result);
  })
);

/** GET /ledger/accounts/:userId —— 账户详情（含重算对比与最近流水） */
router.get(
  '/accounts/:userId',
  rbac('credit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    sendSuccess(res, await adminLedgerService.getAccountDetail(req.params.userId!));
  })
);

/** GET /ledger/accounts/:userId/verify —— 单账户重算校验（只读） */
router.get(
  '/accounts/:userId/verify',
  rbac('credit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    sendSuccess(res, await adminLedgerService.verifyAccount(req.params.userId!));
  })
);

export default router;
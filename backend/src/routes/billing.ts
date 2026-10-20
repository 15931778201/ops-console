/**
 * 计费路由
 * - POST /pre-deduct  预扣（幂等键由客户端生成，同一任务重试保持一致）
 * - POST /confirm     确认（服务端交易 ID）
 * - POST /rollback    回滚（服务端交易 ID，不接受客户端金额）
 * - GET  /transaction/:id  交易状态查询（前端崩溃恢复）
 * - GET  /rules       生效的计费规则目录（前端预估同源）
 */

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { billingService } from '../services/billing.service';
import { asyncHandler } from '../lib/async-handler';
import { sendSuccess, sendPaginated } from '../lib/response';
import { rateLimiter, RATE_RULES, clientIp } from '../lib/rate-limit';
import prisma from '../lib/prisma';

const router = Router();

router.use(authMiddleware);

const preDeductSchema = z.object({
  toolSlug: z.string().min(1).max(64),
  fileCount: z.number().int().min(1).max(500),
  idempotencyKey: z.string().min(8).max(128),
});

const txnIdSchema = z.object({
  transactionId: z.string().uuid(),
});

/** POST /api/billing/pre-deduct */
router.post(
  '/pre-deduct',
  asyncHandler(async (req: AuthRequest, res) => {
    const data = preDeductSchema.parse(req.body);
    const result = await billingService.preDeduct({
      userId: req.user!.id,
      toolSlug: data.toolSlug,
      fileCount: data.fileCount,
      idempotencyKey: data.idempotencyKey,
    });
    sendSuccess(res, result);
  })
);

/** POST /api/billing/confirm */
router.post('/confirm', asyncHandler(async (req: AuthRequest, res) => {
  const { transactionId } = txnIdSchema.parse(req.body);
  await billingService.confirm(transactionId, req.user!.id);
  sendSuccess(res, { confirmed: true });
}));

/** POST /api/billing/rollback */
router.post('/rollback', asyncHandler(async (req: AuthRequest, res) => {
  const { transactionId, reason } = txnIdSchema.extend({
    reason: z.string().max(120).optional(),
  }).parse(req.body);
  await billingService.rollback(transactionId, req.user!.id, reason);
  sendSuccess(res, { rolledBack: true });
}));

/** GET /api/billing/transaction/:id */
router.get('/transaction/:id', asyncHandler(async (req: AuthRequest, res) => {
  const txn = await billingService.getTransaction(req.params.id!, req.user!.id);
  sendSuccess(res, txn);
}));

/** GET /api/billing/rules —— 计费规则目录（前端预估用） */
router.get('/rules', asyncHandler(async (_req: AuthRequest, res) => {
  const rules = await prisma.toolBillingRule.findMany({
    where: { active: true },
    orderBy: { toolSlug: 'asc' },
  });
  sendSuccess(res, { items: rules });
}));

export default router;

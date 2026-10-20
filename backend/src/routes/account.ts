/**
 * 账户路由
 * - GET  /               账户总览（用户 + 积分分账 + 周期）
 * - GET  /credits        积分账户
 * - GET  /transactions   积分流水（分页/筛选）
 * - GET  /sessions       登录设备列表
 */

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { ledgerService } from '../services/ledger.service';
import { sessionService } from '../services/session.service';
import { asyncHandler } from '../lib/async-handler';
import { sendSuccess, sendPaginated } from '../lib/response';
import prisma from '../lib/prisma';
import { PLAN_HIERARCHY } from '../services/billing.service';

const router = Router();

router.use(authMiddleware);

/** GET /api/account —— 账户总览 */
router.get('/', asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const [user, credit] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        avatar: true,
        planId: true,
        planExpiresAt: true,
        createdAt: true,
      },
    }),
    ledgerService.getAccount(userId),
  ]);

  sendSuccess(res, {
    user,
    credit: {
      ...credit,
      totalBalance: credit.balance + credit.bonusBalance,
    },
  });
}));

/** GET /api/account/credits */
router.get('/credits', asyncHandler(async (req: AuthRequest, res) => {
  const credit = await ledgerService.getAccount(req.user!.id);
  sendSuccess(res, { ...credit, totalBalance: credit.balance + credit.bonusBalance });
}));

/** GET /api/account/transactions */
router.get('/transactions', asyncHandler(async (req: AuthRequest, res) => {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      type: z.enum(['CONSUME', 'GRANT', 'RESET', 'REFUND', 'ADJUST', 'INVITE_GRANT', 'BONUS']).optional(),
    })
    .parse(req.query);

  const { items, total } = await ledgerService.getTransactions(req.user!.id, query);
  sendPaginated(res, items, {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  });
}));

/** GET /api/account/sessions —— 登录设备 */
router.get('/sessions', asyncHandler(async (req: AuthRequest, res) => {
  const sessions = await sessionService.listForUser(req.user!.id);
  sendSuccess(res, {
    items: sessions.map((s) => ({
      id: s.id,
      current: s.id === req.user!.sessionId,
      deviceInfo: s.deviceInfo,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
    })),
  });
}));

export { PLAN_HIERARCHY };
export default router;

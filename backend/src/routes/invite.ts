/**
 * 邀请路由
 * 首发范围：邀请码仅作渠道归因/人工活动码，**不自动发放奖励**（《就绪计划》首发范围）。
 */

import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import prisma from '../lib/prisma';
import { asyncHandler } from '../lib/async-handler';
import { sendSuccess, sendPaginated } from '../lib/response';
import { config } from '../lib/config';
import { nanoid } from 'nanoid';

const router = Router();

router.use(authMiddleware);

/** GET /api/invite/my-code */
router.get('/my-code', asyncHandler(async (req: AuthRequest, res) => {
  let inviteCode = await prisma.inviteCode.findFirst({
    where: { ownerUserId: req.user!.id },
  });

  if (!inviteCode) {
    inviteCode = await prisma.inviteCode.create({
      data: {
        code: nanoid(8).toUpperCase(),
        ownerUserId: req.user!.id,
        rewardCredits: config.INVITEE_REWARD_CREDITS,
        inviterCredits: config.INVITER_REWARD_CREDITS,
      },
    });
  }

  sendSuccess(res, {
    code: inviteCode.code,
    rewardCredits: inviteCode.rewardCredits,
    inviterCredits: inviteCode.inviterCredits,
    usedCount: inviteCode.usedCount,
  });
}));

/** GET /api/invite/stats */
router.get('/stats', asyncHandler(async (req: AuthRequest, res) => {
  const [totalInvites, rewardedInvites, totalRewards] = await Promise.all([
    prisma.inviteRelation.count({ where: { inviterUserId: req.user!.id } }),
    prisma.inviteRelation.count({
      where: { inviterUserId: req.user!.id, inviterRewarded: true },
    }),
    prisma.creditTransaction.aggregate({
      where: { userId: req.user!.id, type: 'INVITE_GRANT' },
      _sum: { amount: true },
    }),
  ]);

  sendSuccess(res, {
    totalInvites,
    rewardedInvites,
    totalRewards: totalRewards._sum.amount ?? 0,
  });
}));

/** GET /api/invite/list */
router.get('/list', asyncHandler(async (req: AuthRequest, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10) || 20));

  const [relations, total] = await Promise.all([
    prisma.inviteRelation.findMany({
      where: { inviterUserId: req.user!.id },
      include: { invitee: { select: { id: true, name: true, email: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.inviteRelation.count({ where: { inviterUserId: req.user!.id } }),
  ]);

  sendPaginated(res, relations, {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}));

export default router;

/**
 * 周期额度重置任务
 * - Free：硬重置（周期起始订阅余额归位至套餐额度）
 * - Pro/VIP：归位重置（补差至套餐额度，奖励余额不动）
 * - 会员到期：降级为 free 并重置额度
 */

import prisma from '../lib/prisma';
import { ledgerService } from '../services/ledger.service';
import { logger } from '../lib/logger';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export const periodResetService = {
  async runOnce(): Promise<{ reset: number; downgraded: number }> {
    const now = new Date();
    let reset = 0;
    let downgraded = 0;

    // 1. 到期会员降级
    const expiredVip = await prisma.user.findMany({
      where: {
        planId: { not: 'free' },
        planExpiresAt: { lt: now },
        status: 'ACTIVE',
      },
      select: { id: true, planId: true },
      take: 200,
    });

    for (const user of expiredVip) {
      await prisma.user.update({
        where: { id: user.id },
        data: { planId: 'free', planExpiresAt: null },
      });
      const freePlan = await prisma.plan.findUnique({ where: { id: 'free' } });
      if (freePlan) {
        await ledgerService.resetPeriod(
          user.id,
          freePlan.monthlyCredits,
          now,
          new Date(now.getTime() + MONTH_MS)
        );
      }
      downgraded += 1;
      logger.info({ userId: user.id, from: user.planId }, 'plan_downgraded');
    }

    // 2. 周期结束账户归位重置
    const dueAccounts = await prisma.creditAccount.findMany({
      where: { periodEnd: { lt: now } },
      select: { userId: true, monthlyQuota: true },
      take: 200,
    });

    for (const account of dueAccounts) {
      await ledgerService.resetPeriod(
        account.userId,
        account.monthlyQuota,
        now,
        new Date(now.getTime() + MONTH_MS)
      );
      reset += 1;
    }

    return { reset, downgraded };
  },
};

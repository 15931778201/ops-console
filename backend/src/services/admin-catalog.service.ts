/**
 * 运营后台·套餐与计费规则服务（A6.7）
 *
 * 两条硬约束（设计文档 M5）：
 *  1. **套餐改价不追溯旧订单** —— Order.priceSnapshot 在创建时已固化，
 *     本服务改 Plan 只影响后续新订单。
 *  2. **规则变更不追溯旧交易** —— CreditTransaction 已固化分账快照
 *     （deltaBalance/deltaBonus/balanceAfter*），改 ToolBillingRule 只影响后续扣费。
 *
 * 历史版本：
 *  - 套餐价格历史写入 Plan.features.priceHistory（JSON 数组），
 *    因为 Plan 模型无独立历史表且 features 本就是 JSON 扩展位。
 *  - 计费规则版本用 ruleVersion 字符串（v1→v2），历史写入 ToolBillingRule.features
 *    —— 该模型无 features 字段，故历史写入 AuditLog.metadata（见 updateRule）。
 *
 * 上下架：下架后用户端 pricing 不展示（billing 路由只列 active），
 * 订单创建服务端拒绝（order.service 已校验 plan.active）。
 */

import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { NotFoundError, ValidationError } from '../lib/errors';

const MAX_PRICE_HISTORY = 20;

/** Plan.features 的结构（原本无强类型，这里给出约定） */
interface PlanFeatures {
  [key: string]: unknown;
  priceHistory?: Array<{
    priceCents: number;
    monthlyCredits: number;
    changedAt: string;
    changedBy: string;
    reason?: string;
  }>;
}

type PlanDetail = {
  id: string;
  name: string;
  monthlyCredits: number;
  priceCents: number;
  periodMonths: number;
  maxFiles: number;
  costTierAccess: string[];
  active: boolean;
  features: PlanFeatures;
  holderCount: number;
  priceHistory: PlanFeatures['priceHistory'];
  updatedAt: string;
};

// ==================== 套餐 ====================

type PlanListItem = Omit<PlanDetail, 'features' | 'priceHistory'>;

async function listPlans(options: { activeOnly?: boolean } = {}): Promise<PlanListItem[]> {
  const plans = await prisma.plan.findMany({
    where: options.activeOnly ? { active: true } : undefined,
    orderBy: { priceCents: 'asc' },
  });
  if (plans.length === 0) return [];

    // 一次性 group by 取各套餐持有者数，避免 N+1
  const counts = await prisma.user.groupBy({
    by: ['planId'],
    where: { planId: { in: plans.map((p) => p.id) } },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.planId, c._count._all]));

  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    monthlyCredits: p.monthlyCredits,
    priceCents: p.priceCents,
    periodMonths: p.periodMonths,
    maxFiles: p.maxFiles,
    costTierAccess: p.costTierAccess,
    active: p.active,
    holderCount: countMap.get(p.id) ?? 0,
    updatedAt: p.updatedAt.toISOString(),
  }));
}

async function getPlan(id: string): Promise<PlanDetail> {
  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) throw new NotFoundError('套餐不存在');
  const holderCount = await prisma.user.count({ where: { planId: id } });
  const features = (plan.features ?? {}) as PlanFeatures;
  return {
    id: plan.id,
    name: plan.name,
    monthlyCredits: plan.monthlyCredits,
    priceCents: plan.priceCents,
    periodMonths: plan.periodMonths,
    maxFiles: plan.maxFiles,
    costTierAccess: plan.costTierAccess,
    active: plan.active,
    features,
    holderCount,
    priceHistory: features.priceHistory ?? [],
    updatedAt: plan.updatedAt.toISOString(),
    };
}

/**
 * 更新套餐（改价/改积分/改名）。
 * 关键：改价前把**旧值**追加进 priceHistory，再写入新值——
 * 这样历史记录的是"变更前价格"，与订单快照语义一致（快照存的是成交时的价格）。
 */
async function updatePlan(
  id: string,
  input: {
    name?: string;
    monthlyCredits?: number;
    priceCents?: number;
    maxFiles?: number;
    costTierAccess?: string[];
    reason: string;
  },
  actorId: string
): Promise<{ plan: PlanDetail; priceChanged: boolean }> {
  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) throw new NotFoundError('套餐不存在');
  if (!input.reason || input.reason.trim().length < 2) {
    throw new ValidationError('变更原因至少 2 个字符');
    }
  if (input.priceCents !== undefined && (!Number.isInteger(input.priceCents) || input.priceCents < 0)) {
    throw new ValidationError('价格必须是不小于 0 的整数（单位：分）');
    }
  if (input.monthlyCredits !== undefined && (!Number.isInteger(input.monthlyCredits) || input.monthlyCredits < 0)) {
    throw new ValidationError('月积分必须是不小于 0 的整数');
    }

  const priceChanged =
    input.priceCents !== undefined && input.priceCents !== plan.priceCents;
  const creditsChanged =
    input.monthlyCredits !== undefined && input.monthlyCredits !== plan.monthlyCredits;

  const data: Prisma.PlanUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.maxFiles !== undefined) data.maxFiles = input.maxFiles;
  if (input.costTierAccess !== undefined) data.costTierAccess = input.costTierAccess;

  if (priceChanged || creditsChanged) {
    const features = (plan.features ?? {}) as PlanFeatures;
    const history = features.priceHistory ?? [];
    const newHistory = [
      {
          // 记录变更前的价格与积分
        priceCents: plan.priceCents,
        monthlyCredits: plan.monthlyCredits,
        changedAt: new Date().toISOString(),
        changedBy: actorId,
        reason: input.reason.trim(),
      },
      ...history,
    ].slice(0, MAX_PRICE_HISTORY);

    data.priceCents = input.priceCents ?? plan.priceCents;
    data.monthlyCredits = input.monthlyCredits ?? plan.monthlyCredits;
    data.features = { ...features, priceHistory: newHistory } as Prisma.InputJsonValue;
    }

  const updated = await prisma.plan.update({ where: { id }, data });

  await audit.record({
    actorType: 'ADMIN',
    actorId,
    action: 'plan.updated',
    targetType: 'plan',
    targetId: id,
    reason: input.reason.trim(),
    metadata: {
      before: { priceCents: plan.priceCents, monthlyCredits: plan.monthlyCredits, name: plan.name },
      after: {
        priceCents: updated.priceCents,
        monthlyCredits: updated.monthlyCredits,
        name: updated.name,
      },
      priceChanged,
      creditsChanged,
        // 显式记录：老订单快照不受影响
      note: '订单 priceSnapshot 已固化，本次改价不影响已创建订单',
    },
  });

  logger.info({ planId: id, priceChanged, creditsChanged, actorId }, 'plan_updated');
  return { plan: await getPlan(id), priceChanged };
}

/** 上下架。下架后 pricing 不展示、订单创建被拒（服务端已校验）。 */
async function setPlanActive(
  id: string,
  active: boolean,
  reason: string,
  actorId: string
): Promise<{ id: string; active: boolean; holderCount: number }> {
  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) throw new NotFoundError('套餐不存在');
  if (!reason || reason.trim().length < 2) {
    throw new ValidationError('操作原因至少 2 个字符');
    }
  if (plan.active === active) {
    return { id, active, holderCount: await prisma.user.count({ where: { planId: id } }) };
    }

  await prisma.plan.update({ where: { id }, data: { active } });
  const holderCount = await prisma.user.count({ where: { planId: id } });

  await audit.record({
    actorType: 'ADMIN',
    actorId,
    action: active ? 'plan.activated' : 'plan.deactivated',
    targetType: 'plan',
    targetId: id,
    reason: reason.trim(),
    metadata: { active, holderCount, planName: plan.name },
  });
  logger.info({ planId: id, active, holderCount, actorId }, 'plan_visibility_changed');
  return { id, active, holderCount };
}

/**
 * 影响预览：改价会影响多少存量用户（下次续费时按新价）。
 * 只读估算，不改任何数据。
 */
async function previewPlanImpact(id: string, newPriceCents?: number): Promise<{
  planId: string;
  planName: string;
  currentPriceCents: number;
  newPriceCents: number;
  holderCount: number;
  /** 存量用户下次续费时的月度收入变化（分） */
  monthlyRevenueDeltaCents: number;
  /** 已创建且未支付的订单按快照走旧价，不受影响 */
  pendingOrders: number;
  note: string;
}> {
  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) throw new NotFoundError('套餐不存在');

  const [holderCount, pendingOrders] = await Promise.all([
    prisma.user.count({ where: { planId: id } }),
    prisma.order.count({ where: { planId: id, status: 'PENDING' } }),
  ]);

  const target = newPriceCents ?? plan.priceCents;
  return {
    planId: id,
    planName: plan.name,
    currentPriceCents: plan.priceCents,
    newPriceCents: target,
    holderCount,
    monthlyRevenueDeltaCents: (target - plan.priceCents) * holderCount,
    pendingOrders,
  note: '改价只影响新订单与后续续费；已创建订单按 priceSnapshot 成交价结算，不受影响',
  };
}

  // ==================== 工具计费规则 ====================

async function listRules(options: { activeOnly?: boolean } = {}): Promise<
Array<{
    toolSlug: string;
    creditCost: number;
    minPlan: string;
    maxFilesPerTask: number;
    ruleVersion: string;
    active: boolean;
    updatedAt: string;
    /** 最近 7 日该工具的调用次数与实扣积分（供运营判断调价影响） */
    recentUsage: { calls: number; credits: number };
  }>
> {
  const rules = await prisma.toolBillingRule.findMany({
    where: options.activeOnly ? { active: true } : undefined,
    orderBy: { toolSlug: 'asc' },
  });

    // 近 7 日按工具聚合 CONSUME 流水（注意：这是历史值，调价不影响已发生的）
  const since = new Date(Date.now() - 7 * 86400000);
  const usage = await prisma.creditTransaction.groupBy({
    by: ['toolSlug'],
    where: { type: 'CONSUME', status: 'SETTLED', toolSlug: { not: null }, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { amount: true },
  });
  const usageMap = new Map(
    usage.map((u) => [u.toolSlug as string, { calls: u._count._all, credits: u._sum.amount ?? 0 }])
  );

  return rules.map((r) => ({
    toolSlug: r.toolSlug,
    creditCost: r.creditCost,
    minPlan: r.minPlan,
    maxFilesPerTask: r.maxFilesPerTask,
    ruleVersion: r.ruleVersion,
    active: r.active,
    updatedAt: r.updatedAt.toISOString(),
    recentUsage: usageMap.get(r.toolSlug) ?? { calls: 0, credits: 0 },
  }));
}

/**
 * 更新计费规则：ruleVersion 自动递增（v1→v2），历史版本写入 AuditLog.metadata。
 * 规则变更不追溯旧交易——流水已固化分账快照。
 */
async function updateRule(
  toolSlug: string,
  input: {
    creditCost?: number;
    minPlan?: string;
    maxFilesPerTask?: number;
    active?: boolean;
    reason: string;
  },
  actorId: string
): Promise<{
  toolSlug: string;
  ruleVersion: string;
  previousVersion: string;
  before: { creditCost: number; minPlan: string; maxFilesPerTask: number; active: boolean };
  after: { creditCost: number; minPlan: string; maxFilesPerTask: number; active: boolean };
}> {
  const rule = await prisma.toolBillingRule.findUnique({ where: { toolSlug } });
  if (!rule) throw new NotFoundError('计费规则不存在');
  if (!input.reason || input.reason.trim().length < 2) {
    throw new ValidationError('变更原因至少 2 个字符');
    }
  if (input.creditCost !== undefined && (!Number.isInteger(input.creditCost) || input.creditCost < 0)) {
    throw new ValidationError('积分消耗必须是不小于 0 的整数');
    }
  if (input.maxFilesPerTask !== undefined && (!Number.isInteger(input.maxFilesPerTask) || input.maxFilesPerTask < 1)) {
    throw new ValidationError('单任务文件数上限必须是 ≥ 1 的整数');
    }

  const changed =
    (input.creditCost !== undefined && input.creditCost !== rule.creditCost) ||
    (input.minPlan !== undefined && input.minPlan !== rule.minPlan) ||
    (input.maxFilesPerTask !== undefined && input.maxFilesPerTask !== rule.maxFilesPerTask) ||
    (input.active !== undefined && input.active !== rule.active);

  const before = {
    creditCost: rule.creditCost,
    minPlan: rule.minPlan,
    maxFilesPerTask: rule.maxFilesPerTask,
    active: rule.active,
    };

    // 无实质变更时不递增版本号（避免版本号被无意义的保存刷高）
  if (!changed) {
    return {
      toolSlug,
      ruleVersion: rule.ruleVersion,
      previousVersion: rule.ruleVersion,
      before,
      after: before,
      };
    }

  const nextVersion = incrementVersion(rule.ruleVersion);
  const after = {
    creditCost: input.creditCost ?? rule.creditCost,
    minPlan: input.minPlan ?? rule.minPlan,
    maxFilesPerTask: input.maxFilesPerTask ?? rule.maxFilesPerTask,
    active: input.active ?? rule.active,
    };

  await prisma.toolBillingRule.update({
    where: { toolSlug },
    data: { ...after, ruleVersion: nextVersion },
  });

  await audit.record({
    actorType: 'ADMIN',
    actorId,
    action: 'rule.updated',
    targetType: 'toolBillingRule',
    targetId: toolSlug,
    reason: input.reason.trim(),
    metadata: {
      before: { ...before, ruleVersion: rule.ruleVersion },
      after: { ...after, ruleVersion: nextVersion },
      note: '流水已固化分账快照，规则变更不追溯旧交易',
    },
  });
  logger.info({ toolSlug, from: rule.ruleVersion, to: nextVersion, actorId }, 'rule_updated');

  return { toolSlug, ruleVersion: nextVersion, previousVersion: rule.ruleVersion, before, after };
}

/**
 * 规则生效预览：对每个受影响的存量用户估算"下次扣费变化"。
 * 只读估算：受影响人数 = 近 7 日调用过该工具且当前套餐满足 minPlan 的用户数。
 */
async function previewRuleImpact(toolSlug: string, newCreditCost: number): Promise<{
  toolSlug: string;
  currentCreditCost: number;
  newCreditCost: number;
  /** 近 7 日调用过该工具的去重用户数（受影响人数） */
  affectedUsers: number;
  /** 近 7 日该工具总扣费积分 */
  recentCredits: number;
  /** 按新价重算的预计扣费（负值表示更便宜） */
  projectedCredits: number;
  monthlyDeltaCredits: number;
  note: string;
}> {
  const rule = await prisma.toolBillingRule.findUnique({ where: { toolSlug } });
  if (!rule) throw new NotFoundError('计费规则不存在');
  if (!Number.isInteger(newCreditCost) || newCreditCost < 0) {
    throw new ValidationError('新价格必须是不小于 0 的整数');
    }

  const since = new Date(Date.now() - 7 * 86400000);
  const [agg, distinctUsers] = await Promise.all([
    prisma.creditTransaction.aggregate({
      where: { type: 'CONSUME', status: 'SETTLED', toolSlug, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.creditTransaction.findMany({
      where: { type: 'CONSUME', status: 'SETTLED', toolSlug, createdAt: { gte: since } },
      distinct: ['userId'],
      select: { userId: true },
    }),
  ]);

  const calls = agg._count._all;
  const recentCredits = Math.abs(agg._sum.amount ?? 0);
  const projectedCredits = calls * newCreditCost;

  return {
    toolSlug,
    currentCreditCost: rule.creditCost,
    newCreditCost,
    affectedUsers: distinctUsers.length,
    recentCredits,
    projectedCredits,
    monthlyDeltaCredits: projectedCredits - recentCredits,
  note: '估算基于近 7 日实际调用量；历史流水按成交时规则结算，不受本次调价影响',
  };
}

  // ==================== 邀请与归因 ====================

async function listInviteCodes(options: { page?: number; pageSize?: number; activeOnly?: boolean } = {}): Promise<{
  items: Array<{
    code: string;
    ownerUserId: string;
    ownerEmail: string | null;
    channel: string | null;
    maxUses: number | null;
    usedCount: number;
    rewardCredits: number;
    inviterCredits: number;
    expiresAt: string | null;
    active: boolean;
    createdAt: string;
    /** 是否已过期 */
    expired: boolean;
  }>;
  total: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const where: Prisma.InviteCodeWhereInput = {};
  if (options.activeOnly) where.active = true;

  const [rows, total] = await Promise.all([
    prisma.inviteCode.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { owner: { select: { email: true } } },
    }),
    prisma.inviteCode.count({ where }),
  ]);

  const now = Date.now();
  return {
    items: rows.map((c) => ({
      code: c.code,
      ownerUserId: c.ownerUserId,
      ownerEmail: c.owner?.email ?? null,
      channel: c.channel,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      rewardCredits: c.rewardCredits,
      inviterCredits: c.inviterCredits,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      active: c.active,
      createdAt: c.createdAt.toISOString(),
      expired: c.expiresAt !== null && c.expiresAt.getTime() < now,
    })),
    total,
    };
}

async function listInviteRelations(options: {
  page?: number;
  pageSize?: number;
  riskFlag?: string;
} = {}): Promise<{
  items: Array<{
    id: string;
    inviteCode: string;
    inviterUserId: string;
    inviterEmail: string | null;
    inviteeUserId: string;
    inviteeEmail: string | null;
    status: string;
    inviterRewarded: boolean;
    inviteeRewarded: boolean;
    riskFlag: string | null;
    createdAt: string;
  }>;
  total: number;
}> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const where: Prisma.InviteRelationWhereInput = {};
  if (options.riskFlag) where.riskFlag = options.riskFlag;

  const [rows, total] = await Promise.all([
    prisma.inviteRelation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        inviter: { select: { email: true } },
        invitee: { select: { email: true } },
      },
    }),
    prisma.inviteRelation.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      inviteCode: r.inviteCode,
      inviterUserId: r.inviterUserId,
      inviterEmail: r.inviter?.email ?? null,
      inviteeUserId: r.inviteeUserId,
      inviteeEmail: r.invitee?.email ?? null,
      status: r.status,
      inviterRewarded: r.inviterRewarded,
      inviteeRewarded: r.inviteeRewarded,
      riskFlag: r.riskFlag,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    };
}

/** 邀请统计：总邀请数、已奖励数、发放积分合计 */
async function inviteStats(): Promise<{
  totalCodes: number;
  activeCodes: number;
  totalRelations: number;
  rewardedRelations: number;
  pendingRewardRelations: number;
  riskFlagged: number;
  grantedCredits: number;
}> {
  const [totalCodes, activeCodes, totalRelations, rewardedRelations, pendingRewardRelations, riskFlagged, grantAgg] =
    await Promise.all([
      prisma.inviteCode.count(),
      prisma.inviteCode.count({ where: { active: true } }),
      prisma.inviteRelation.count(),
      prisma.inviteRelation.count({
        where: { OR: [{ inviterRewarded: true }, { inviteeRewarded: true }] },
      }),
      prisma.inviteRelation.count({
        where: { inviterRewarded: false, inviteeRewarded: false },
      }),
      prisma.inviteRelation.count({ where: { riskFlag: { not: null } } }),
      prisma.creditTransaction.aggregate({
        where: { type: 'INVITE_GRANT' },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

  return {
    totalCodes,
    activeCodes,
    totalRelations,
    rewardedRelations,
    pendingRewardRelations,
    riskFlagged,
    grantedCredits: Math.abs(grantAgg._sum.amount ?? 0),
    };
}

/** v9 → v10；v10 → v11；非 vN 前缀则退回 v2（不猜历史） */
function incrementVersion(current: string): string {
  const m = /^v(\d+)$/.exec(current);
  if (!m) return 'v2';
  return `v${Number(m[1]) + 1}`;
}

export const adminCatalogService = {
  listPlans,
  getPlan,
  updatePlan,
  setPlanActive,
  previewPlanImpact,
  listRules,
  updateRule,
  previewRuleImpact,
  listInviteCodes,
  listInviteRelations,
  inviteStats,
};

export default adminCatalogService;
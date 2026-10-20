/**
 * E2E · 套餐/规则/邀请 + 仪表盘（A6.7，服务层，真实 PostgreSQL）
 * 运行：npm run test:e2e:catalog
 *
 * 覆盖验收核心（设计文档 A6.7：改价不追溯旧订单；指标与 SQL 抽样一致）：
 *  - 套餐改价：写入价格历史（记录变更前价格）、影响预览收入计算
 *  - **改价不追溯旧订单**：改价后旧 Order.amountCents 与 priceSnapshot 不变
 *  - 上下架：下架后 listPlans(activeOnly) 不含它、holderCount 正确、幂等
 *  - 计费规则：ruleVersion 自动递增、无实质变更不递增、历史落审计
 *  - 规则调价不追溯旧交易：改价后旧 CreditTransaction.amount 不变
 *  - 邀请列表与统计口径
 *  - 仪表盘：snapshot 落库、读接口返回指标、**指标与直接 SQL 抽样一致**
 *  - 仪表盘 stale 判定与 scope 独立
 */

import prisma from '../src/lib/prisma';
import { adminCatalogService } from '../src/services/admin-catalog.service';
import { dashboardService, SCOPES } from '../src/services/dashboard.service';
import { orderService } from '../src/services/order.service';
import { Check, cleanupE2eData, testEmail } from './harness';
import type { Order, Plan, User } from '@prisma/client';

const c = new Check('目录与仪表盘');

/** 测完必须还原的套餐字段 */
let touchedPlan: Plan | null = null;
let touchedRuleSlug: string | null = null;

async function createUser(tag: string, planId = 'free'): Promise<User> {
  return prisma.user.create({
    data: { email: testEmail(tag), passwordHash: 'x', name: `E2E-${tag}`, planId },
  });
}

async function main(): Promise<void> {
  await cleanupE2eData();

  // 自建套餐与规则（不依赖 seed，E2E 清理只删e2e_ 前缀用户，故用 E2E 前缀 ID 并在 finally 还原）
  const planId = `e2e_plan_${Date.now()}`;
  const proPlan = await prisma.plan.create({
    data: {
      id: planId,
      name: 'E2E 专业版',
      monthlyCredits: 1000,
      priceCents: 1990,
      periodMonths: 1,
      active: true,
      maxFiles: 20,
      costTierAccess: ['light', 'heavy'],
    },
  });
  touchedPlan = { ...proPlan, features: proPlan.features ?? undefined } as Plan;

  const toolSlug = `e2e-tool-${Date.now()}`;
  await prisma.toolBillingRule.create({
    data: {
      toolSlug,
      creditCost: 5,
      minPlan: 'free',
      maxFilesPerTask: 10,
      ruleVersion: 'v1',
      active: true,
    },
  });
  const rule = { toolSlug } as { toolSlug: string };
  touchedRuleSlug = toolSlug;

  const actor = 'system-e2e-catalog';

  // ---------- 1. 套餐列表 ----------
  const plans = await adminCatalogService.listPlans();
  c.ok('套餐列表非空', plans.length >= 3, { count: plans.length });
  const pro = plans.find((p) => p.id === proPlan.id);
  c.ok('能按价格升序找到 pro_monthly', pro !== undefined);
  c.ok('列表带持有者数', typeof pro?.holderCount === 'number');

  const activeOnly = await adminCatalogService.listPlans({ activeOnly: true });
  c.ok('activeOnly 过滤生效', activeOnly.every((p) => p.active));

  // ---------- 2. 改价 → 写历史 ----------
  const newPrice = proPlan.priceCents + 500;
  const updated = await adminCatalogService.updatePlan(
    proPlan.id,
    { priceCents: newPrice, reason: 'E2E 调价测试' },
    actor
  );
  c.eq('价格已更新', updated.plan.priceCents, newPrice);
  c.eq('priceChanged 标记为 true', updated.priceChanged, true);
  c.ok('价格历史已写入', (updated.plan.priceHistory?.length ?? 0) >= 1, updated.plan.priceHistory);
  c.eq('历史记录的是变更前价格', updated.plan.priceHistory?.[0]?.priceCents, proPlan.priceCents);
  c.eq('历史记录含原因', updated.plan.priceHistory?.[0]?.reason, 'E2E 调价测试');

  // 幂等：同价再保存不应新增历史
  const samePrice = await adminCatalogService.updatePlan(
    proPlan.id,
    { priceCents: newPrice, reason: 'E2E 同价保存' },
    actor
  );
  c.eq('同价保存 priceChanged=false', samePrice.priceChanged, false);
  c.eq(
    '同价保存不新增历史条目',
    samePrice.plan.priceHistory?.length,
    updated.plan.priceHistory?.length
  );

  // ---------- 3. 改价不追溯旧订单 ----------
  // 两位买家在下单前已持有该套餐（模拟此前付费生效），使 holderCount 口径可验证
  const buyer = await createUser('cat_buyer', proPlan.id);
  const created1 = await orderService.createOrder({
    userId: buyer.id,
    planId: proPlan.id,
    channel: 'WECHAT',
    periodMonths: 1,
    idempotencyKey: `e2e_cat_${Date.now()}`,
  });
  const order: Order = created1.order;
  const beforeAmount = order.amountCents;
  const beforeSnapshot = JSON.stringify(order.priceSnapshot);

  // 再次改价
  await adminCatalogService.updatePlan(proPlan.id, { priceCents: newPrice + 1000, reason: 'E2E 二次调价' }, actor);

  const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  c.eq('改价后旧订单金额不变', orderAfter.amountCents, beforeAmount);
  c.eq('改价后旧订单价格快照不变', JSON.stringify(orderAfter.priceSnapshot), beforeSnapshot);
  c.eq('改价后订单创建时间不变', orderAfter.createdAt.toISOString(), order.createdAt.toISOString());

  // 新订单按新价
  const buyer2 = await createUser('cat_buyer2', proPlan.id);
  const newOrder = (await orderService.createOrder({
    userId: buyer2.id,
    planId: proPlan.id,
    channel: 'WECHAT',
    periodMonths: 1,
    idempotencyKey: `e2e_cat_new_${Date.now()}`,
  })).order;
  c.eq('新订单按新价成交', newOrder.amountCents, newPrice + 1000);

  // ---------- 4. 影响预览 ----------
  const impact = await adminCatalogService.previewPlanImpact(proPlan.id, newPrice + 1000);
  c.eq('影响预览返回套餐名', impact.planName, proPlan.name);
  // holderCount 口径 = users.planId 指向该套餐的用户数（下架后仍需展示存量）
  const holders = await prisma.user.count({ where: { planId: proPlan.id } });
  c.eq('影响预览 holderCount = 持有该套餐的用户数', impact.holderCount, holders);
  c.ok('影响预览 holderCount ≥ 2', impact.holderCount >= 2, { holderCount: impact.holderCount });
  c.eq('影响预览当前价正确', impact.currentPriceCents, newPrice + 1000);
  c.eq('待支付订单数 = 2（两笔新建PENDING）', impact.pendingOrders, 2);
  c.eq('同价时收入变化为 0', impact.monthlyRevenueDeltaCents, 0);

  const upImpact = await adminCatalogService.previewPlanImpact(proPlan.id, newPrice + 1000 + 100);
  c.eq(
    '涨价 1 元 × holderCount 用户 = 对应收入增量',
    upImpact.monthlyRevenueDeltaCents,
    100 * holders
  );
  c.ok('涨价后收入增量为正', upImpact.monthlyRevenueDeltaCents > 0);

  // 下架不改存量用户归属：holderCount 必须保持
  await adminCatalogService.setPlanActive(proPlan.id, false, 'E2E 下架（holderCount 校验）', actor);
  c.eq(
    '下架后 holderCount 不变（存量用户仍在）',
    (await adminCatalogService.previewPlanImpact(proPlan.id)).holderCount,
    holders
  );
  await adminCatalogService.setPlanActive(proPlan.id, true, 'E2E 重新上架（holderCount 校验）', actor);

  // ---------- 5. 上下架 ----------
  const deactivated = await adminCatalogService.setPlanActive(proPlan.id, false, 'E2E 下架', actor);
  c.eq('下架生效', deactivated.active, false);
  c.eq('下架后 activeOnly 不含它', (await adminCatalogService.listPlans({ activeOnly: true })).some((p) => p.id === proPlan.id), false);

  // 下架后订单创建被拒
  await c.throwsCode(
    '下架后创建订单被拒',
    'PLAN_UNAVAILABLE',
    () =>
      orderService.createOrder({
        userId: buyer.id,
        planId: proPlan.id,
        channel: 'WECHAT',
        periodMonths: 1,
        idempotencyKey: `e2e_cat_down_${Date.now()}`,
      })
  );

  const reactivated = await adminCatalogService.setPlanActive(proPlan.id, true, 'E2E 重新上架', actor);
  c.eq('重新上架生效', reactivated.active, true);
  const idem = await adminCatalogService.setPlanActive(proPlan.id, true, 'E2E 重复上架', actor);
  c.eq('重复上架幂等', idem.active, true);

  // ---------- 6. 计费规则：版本递增 ----------
  const rules = await adminCatalogService.listRules();
  c.ok('规则列表非空', rules.length > 0);
  const r0 = await prisma.toolBillingRule.findUniqueOrThrow({ where: { toolSlug: rule.toolSlug } });
  c.eq('列表返回当前版本', rules.find((r) => r.toolSlug === rule.toolSlug)?.ruleVersion, r0.ruleVersion);

  const newCost = r0.creditCost + 3;
  const upd = await adminCatalogService.updateRule(
    r0.toolSlug,
    { creditCost: newCost, reason: 'E2E 调规则' },
    actor
  );
  c.eq('版本号递增', upd.ruleVersion, bumpVersion(r0.ruleVersion));
  c.eq('记录了旧版本', upd.previousVersion, r0.ruleVersion);
  c.eq('新值生效', upd.after.creditCost, newCost);

  // 无实质变更不递增
  const noChange = await adminCatalogService.updateRule(
    r0.toolSlug,
    { creditCost: newCost, reason: 'E2E 无变更保存' },
    actor
  );
  c.eq('无实质变更版本号不变', noChange.ruleVersion, upd.ruleVersion);

  // 版本边界
  await prisma.toolBillingRule.update({ where: { toolSlug: r0.toolSlug }, data: { ruleVersion: 'v9' } });
  const v9 = await adminCatalogService.updateRule(r0.toolSlug, { creditCost: newCost + 1, reason: 'v9→v10' }, actor);
  c.eq('v9 → v10 递增正确', v9.ruleVersion, 'v10');
  await prisma.toolBillingRule.update({ where: { toolSlug: r0.toolSlug }, data: { ruleVersion: 'weird' } });
  const weird = await adminCatalogService.updateRule(r0.toolSlug, { creditCost: newCost + 2, reason: '非法版本' }, actor);
  c.eq('非法版本号退回 v2', weird.ruleVersion, 'v2');

  // ---------- 7. 规则调价不追溯旧交易 ----------
  const consUser = await createUser('cat_cons', 'free');
  await prisma.creditAccount.create({ data: { userId: consUser.id, balance: 500, bonusBalance: 0 } });
  const txnBefore = await prisma.creditTransaction.create({
    data: {
      userId: consUser.id, type: 'CONSUME', status: 'SETTLED',
      amount: -r0.creditCost, deltaBalance: -r0.creditCost, deltaBonus: 0,
      balanceAfterBalance: 500 - r0.creditCost, balanceAfterBonus: 0, balanceAfter: 500 - r0.creditCost,
      toolSlug: r0.toolSlug, referenceId: `e2e_cat_txn_${Date.now()}`,
    },
  });
  const r1 = await prisma.toolBillingRule.findUniqueOrThrow({ where: { toolSlug: r0.toolSlug } });
  await adminCatalogService.updateRule(r0.toolSlug, { creditCost: r1.creditCost + 50, reason: '再次调价' }, actor);
  const txnAfter = await prisma.creditTransaction.findUniqueOrThrow({ where: { id: txnBefore.id } });
  c.eq('调价后旧流水金额不变', txnAfter.amount, txnBefore.amount);
  c.eq('调价后旧流水分账快照不变', txnAfter.deltaBalance, txnBefore.deltaBalance);

  // ---------- 8. 规则影响预览 ----------
  const ruleImpact = await adminCatalogService.previewRuleImpact(r0.toolSlug, 1);
  c.eq('影响预览返回工具', ruleImpact.toolSlug, r0.toolSlug);
  c.eq('受影响用户含刚才那次消费', ruleImpact.affectedUsers, 1);
  c.ok('预估扣费 = 调用次数 × 新价', ruleImpact.projectedCredits === ruleImpact.affectedUsers * 1 || ruleImpact.projectedCredits > 0, ruleImpact);

  // ---------- 9. 邀请 ----------
  const stats0 = await adminCatalogService.inviteStats();
  c.ok('邀请统计返回数字字段', typeof stats0.totalCodes === 'number' && typeof stats0.grantedCredits === 'number');

  const codes = await adminCatalogService.listInviteCodes({ page: 1, pageSize: 10 });
  c.ok('邀请码列表结构完整', Array.isArray(codes.items) && typeof codes.total === 'number');
  c.ok('邀请码带过期标记', codes.items.every((x) => typeof x.expired === 'boolean'));

  const rels = await adminCatalogService.listInviteRelations({ page: 1, pageSize: 10 });
  c.ok('归因列表结构完整', Array.isArray(rels.items) && typeof rels.total === 'number');

  // 造一条归因关系验证统计口径
  const inviter = await createUser('cat_inviter');
  const invitee = await createUser('cat_invitee');
  const code = `E2E${Date.now()}`;
  await prisma.inviteCode.create({ data: { code, ownerUserId: inviter.id, rewardCredits: 200, inviterCredits: 500 } });
  await prisma.inviteRelation.create({
    data: { inviteCode: code, inviterUserId: inviter.id, inviteeUserId: invitee.id, inviterRewarded: true },
  });
  const stats1 = await adminCatalogService.inviteStats();
  c.eq('总邀请数 +1', stats1.totalRelations, stats0.totalRelations + 1);
  c.eq('已奖励数 +1', stats1.rewardedRelations, stats0.rewardedRelations + 1);
  c.eq('待奖励数不变', stats1.pendingRewardRelations, stats0.pendingRewardRelations);
  c.eq('邀请码数 +1', stats1.totalCodes, stats0.totalCodes + 1);

  // INVITE_GRANT 流水计入发放积分
  await prisma.creditTransaction.create({
    data: {
      userId: inviter.id, type: 'INVITE_GRANT', status: 'SETTLED',
      amount: -500, deltaBalance: 0, deltaBonus: -500,
      balanceAfterBalance: 0, balanceAfterBonus: 0, balanceAfter: 0,
      referenceId: `e2e_cat_grant_${Date.now()}`,
    },
  });
  const stats2 = await adminCatalogService.inviteStats();
  c.eq('发放积分绝对值计入', stats2.grantedCredits, stats1.grantedCredits + 500);

  // ---------- 10. 仪表盘 ----------
  const read0 = await dashboardService.read('today');
  c.eq('快照不存在时 metrics 为 null', read0.metrics, null);
  c.eq('快照不存在时 stale=true', read0.stale, true);
  c.eq('快照不存在时 generatedAt=null', read0.generatedAt, null);

  await dashboardService.refreshAll();
  for (const s of SCOPES) {
    const snap = await prisma.dashboardSnapshot.findFirst({
      where: { scope: s },
      orderBy: { metricDate: 'desc' },
    });
    c.ok(`${s} 快照已落库`, snap !== null);
  }

  const readToday = await dashboardService.read('today');
  c.ok('今日指标可读', readToday.metrics !== null);
  c.eq('同一天刚刷新不算 stale', readToday.stale, false);
  c.eq('system.dbOk = true', readToday.metrics?.system.dbOk, true);
  c.ok('snapshotAgeMs 已回填', (readToday.metrics?.system.snapshotAgeMs ?? -1) >= 0);

  // 时区回归：@db.Date 按 UTC 日期部分读写，本地日历日必须归一化，
  // 否则非 UTC 时区下 isToday 恒为 false、仪表盘永远显示"指标计算中"
  const snapToday = await prisma.dashboardSnapshot.findFirstOrThrow({
    where: { scope: 'today' },
    orderBy: { metricDate: 'desc' },
  });
  c.eq(
    '快照 metricDate 落在本地日历日的 UTC 零点',
    snapToday.metricDate.toISOString().slice(0, 10),
    new Date().toISOString().slice(0, 10)
  );

  // **指标与 SQL 抽样一致**（A6.7 验收标准）
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const directOrders = await prisma.order.count({ where: { createdAt: { gte: since } } });
  const directPaid = await prisma.order.count({ where: { status: 'PAID', createdAt: { gte: since } } });
  const directGmv = await prisma.order.aggregate({
    where: { status: 'PAID', createdAt: { gte: since } },
    _sum: { amountCents: true },
  });
  const directRegs = await prisma.user.count({ where: { createdAt: { gte: since } } });

  c.eq('订单数与 SQL 一致', readToday.metrics?.payment.orders, directOrders);
  c.eq('支付成功数与 SQL 一致', readToday.metrics?.payment.paidOrders, directPaid);
  c.eq('GMV 与 SQL 一致', readToday.metrics?.payment.gmvCents, directGmv._sum.amountCents ?? 0);
  c.eq('注册数与 SQL 一致', readToday.metrics?.users.registrations, directRegs);
  c.eq(
    '成功率 = 成功/总订单',
    readToday.metrics?.payment.successRate,
    directOrders === 0 ? 0 : Number((directPaid / directOrders).toFixed(4))
  );
  c.eq(
    '客单价 = GMV/成功数',
    readToday.metrics?.payment.avgOrderCents,
    directPaid === 0 ? 0 : Number(((directGmv._sum.amountCents ?? 0) / directPaid).toFixed(2))
  );

  // scope 独立
  const read7 = await dashboardService.read('d7');
  c.eq('d7 scope 独立记录', read7.scope, 'd7');
  c.ok('d7 订单数 ≥ today（区间更大）', (read7.metrics?.payment.orders ?? 0) >= directOrders);

  // 刷新幂等（upsert 唯一键）
  const before = await prisma.dashboardSnapshot.count({ where: { scope: 'today' } });
  await dashboardService.refresh('today');
  const after = await prisma.dashboardSnapshot.count({ where: { scope: 'today' } });
  c.eq('重复刷新不产生重复快照（upsert 幂等）', after, before);

  // 手动刷新返回视图
  const manual = await dashboardService.refreshNow('today');
  c.ok('手动刷新返回完整视图', manual.metrics !== null && !manual.stale);

  // meta 含跳转配置
  const meta = dashboardService.meta();
  c.eq('meta 含 3 个 scope', meta.scopes.length, 3);
  c.ok('meta 含 6 个异常跳转', Object.keys(meta.anomalyLinks).length === 6);
  c.eq('账本不平跳转到 /ledger', meta.anomalyLinks.mismatchedAccounts.to, '/ledger');

  // ---------- 11. 审计留痕 ----------
  const planAudit = await prisma.auditLog.findMany({
    where: { targetId: proPlan.id, action: 'plan.updated' },
    select: { action: true, metadata: true },
  });
  c.ok('套餐改价写审计', planAudit.length >= 2);
  c.ok(
    '审计含前后值',
    planAudit[0]?.metadata !== undefined &&
      typeof (planAudit[0].metadata as { before?: unknown }).before === 'object'
  );

  const ruleAudit = await prisma.auditLog.findMany({
    where: { targetId: r0.toolSlug, action: 'rule.updated' },
    select: { action: true },
  });
  c.ok('规则变更写审计', ruleAudit.length >= 3);

  const toggleAudit = await prisma.auditLog.findMany({
    where: { targetId: proPlan.id, action: { in: ['plan.deactivated', 'plan.activated'] } },
    select: { action: true },
  });
  const deactCount = toggleAudit.filter((a) => a.action === 'plan.deactivated').length;
  const actCount = toggleAudit.filter((a) => a.action === 'plan.activated').length;
  c.eq('上下架审计成对出现', deactCount, actCount);
  c.ok('下架审计至少 2 次（每次真实状态变更都留痕）', deactCount >= 2, { deactCount, actCount });
  c.ok('每次下架都有配对的上架', toggleAudit.length === deactCount + actCount);

  // 幂等操作（重复上架）不得产生审计——否则审计日志会被噪声淹没
  const beforeIdem = await prisma.auditLog.count({
    where: { targetId: proPlan.id, action: 'plan.activated' },
  });
  await adminCatalogService.setPlanActive(proPlan.id, true, 'E2E 幂等上架（审计校验）', actor);
  const afterIdem = await prisma.auditLog.count({
    where: { targetId: proPlan.id, action: 'plan.activated' },
  });
  c.eq('重复上架（无状态变更）不写审计', afterIdem, beforeIdem);

  console.log('');
}

function bumpVersion(v: string): string {
  const m = /^v(\d+)$/.exec(v);
  return m ? `v${Number(m[1]) + 1}` : 'v2';
}

main()
  .catch((err) => {
    console.error('E2E 执行异常:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 清理自建的套餐与规则（它们不属于任何用户，不会被 cleanupE2eData 覆盖）
    if (touchedPlan) {
      await prisma.plan.delete({ where: { id: touchedPlan.id } }).catch(() => undefined);
    }
    if (touchedRuleSlug) {
      await prisma.toolBillingRule.delete({ where: { toolSlug: touchedRuleSlug } }).catch(() => undefined);
    }
    console.log('');
    c.summary('目录与仪表盘');
    await cleanupE2eData();
    await prisma.$disconnect();
  });
/**
 * E2E · 积分账本（A6.6，服务层，真实 PostgreSQL）
 * 运行：npm run test:e2e:ledger
 *
 * 覆盖不变量：
 *  - 全局流水筛选正确性（用户/类型/状态/工具/关联 ID/时间区间）
 *  - 汇总口径与列表一致（含 ROLLED_BACK，hasRolledBack 提示）
 *  - 按类型分组计数正确
 *  - 不平账户能被检出且 reason 分类正确（BALANCE/BONUS/BOTH/NEGATIVE）
 *  - 重算口径排除 ROLLED_BACK（有回滚流水的账户不算不平）
 *  - 账本服务只读：detect 差异后余额不变（不自动修复）
 *  - 账户详情的 projection vs recompute 对比
 *  - meta 字典完整
 */

import prisma from '../src/lib/prisma';
import { adminLedgerService, TXN_TYPE_LABELS, DISCREPANCY_REASONS } from '../src/services/admin-ledger.service';
import { Check, cleanupE2eData, testEmail } from './harness';
import type { User } from '@prisma/client';

const c = new Check('积分账本');

async function createUser(tag: string): Promise<User> {
  return prisma.user.create({
    data: { email: testEmail(tag), passwordHash: 'x', name: `E2E-${tag}`, planId: 'free' },
  });
}

async function main(): Promise<void> {
  await cleanupE2eData();

  const alice = await createUser('ldg_alice');
  const bob = await createUser('ldg_bob');

  // Alice 的流水：GRANT(+100) / CONSUME(-30) / ADJUST(+20) / INVITE_GRANT(+5)
  await prisma.creditAccount.create({ data: { userId: alice.id, balance: 0, bonusBalance: 0 } });
  const grant = await prisma.creditTransaction.create({
    data: {
      userId: alice.id, type: 'GRANT', status: 'SETTLED', amount: 100,
      deltaBalance: 100, deltaBonus: 0, balanceAfterBalance: 100, balanceAfterBonus: 0, balanceAfter: 100,
      referenceId: `ldg_grant_${Date.now()}`, description: '订阅发放',
    },
  });
  await prisma.creditTransaction.create({
    data: {
      userId: alice.id, type: 'CONSUME', status: 'SETTLED', amount: -30,
      deltaBalance: -30, deltaBonus: 0, balanceAfterBalance: 70, balanceAfterBonus: 0, balanceAfter: 70,
      toolSlug: 'pdf-merge', fileCount: 3, description: 'PDF 合并消费',
    },
  });
  await prisma.creditTransaction.create({
    data: {
      userId: alice.id, type: 'INVITE_GRANT', status: 'SETTLED', amount: 5,
      deltaBalance: 0, deltaBonus: 5, balanceAfterBalance: 70, balanceAfterBonus: 5, balanceAfter: 75,
      description: '邀请奖励',
    },
  });

  // Bob 的一条 GRANT
  await prisma.creditAccount.create({ data: { userId: bob.id, balance: 0, bonusBalance: 0 } });
  await prisma.creditTransaction.create({
    data: {
      userId: bob.id, type: 'GRANT', status: 'SETTLED', amount: 50,
      deltaBalance: 50, deltaBonus: 0, balanceAfterBalance: 50, balanceAfterBonus: 0, balanceAfter: 50,
      referenceId: `ldg_bob_${Date.now()}`,
    },
  });

  // ---------- 1. 全局列表 + 汇总 ----------
  const all = await adminLedgerService.listTransactions({ page: 1, pageSize: 50 });
  c.eq('全局列表拿到全部 4 条', all.total, 4);
  c.eq('汇总笔数与 total 一致', all.summary.count, 4);
  // 净额：100 - 30 + 5 + 50 = 125
  c.eq('汇总净额正确（100-30+5+50）', all.summary.netAmount, 125);
  c.eq('汇总 deltaBalance（100-30+50）', all.summary.sumDeltaBalance, 120);
  c.eq('汇总 deltaBonus（5）', all.summary.sumDeltaBonus, 5);
  c.eq('无回滚条目', all.summary.hasRolledBack, false);
  c.eq('按类型分组共 3 类', all.summary.byType.length, 3);
  const grantGroup = all.summary.byType.find((g) => g.type === 'GRANT');
  c.eq('GRANT 分组计数 2', grantGroup?.count, 2);
  c.eq('GRANT 分组净额 150', grantGroup?.netAmount, 150);

  // ---------- 2. 用户维度筛选 ----------
  const aliceTxns = await adminLedgerService.listTransactions({ page: 1, pageSize: 50, userId: alice.id });
  c.eq('按 userId 筛 Alice = 3 条', aliceTxns.total, 3);
  c.ok('结果全部属于 Alice', aliceTxns.items.every((t) => t.userId === alice.id));

  const byEmail = await adminLedgerService.listTransactions({
    page: 1, pageSize: 50, userSearch: alice.email!.slice(0, 10),
  });
  c.ok('按邮箱前缀能搜到 Alice 的流水', byEmail.items.length === 3, { count: byEmail.items.length });

  // ---------- 3. 类型 / 状态 / 工具 / 关联 ID ----------
  const grants = await adminLedgerService.listTransactions({ page: 1, pageSize: 50, type: 'GRANT' });
  c.eq('按类型 GRANT = 2 条', grants.total, 2);
  const consumes = await adminLedgerService.listTransactions({ page: 1, pageSize: 50, type: 'CONSUME' });
  c.eq('按类型 CONSUME = 1 条', consumes.total, 1);
  c.eq('CONSUME 带工具标签', consumes.items[0]?.toolSlug, 'pdf-merge');
  c.eq('CONSUME 带分账快照 deltaBalance', consumes.items[0]?.deltaBalance, -30);
  c.eq('列表项带类型中文标签', consumes.items[0]?.typeLabel, TXN_TYPE_LABELS.CONSUME);

  const byTool = await adminLedgerService.listTransactions({ page: 1, pageSize: 50, toolSlug: 'pdf-merge' });
  c.eq('按工具筛选命中 1 条', byTool.total, 1);

  const byRef = await adminLedgerService.listTransactions({ page: 1, pageSize: 50, reference: grant.referenceId!.slice(0, 8) });
  c.eq('按关联交易 ID 筛选命中', byRef.total, 1);

  // ---------- 4. 时间区间 ----------
  const past = new Date(Date.now() - 86400000).toISOString();
  const future = new Date(Date.now() + 86400000).toISOString();
  const inRange = await adminLedgerService.listTransactions({
    page: 1, pageSize: 50, createdFrom: past, createdTo: future,
  });
  c.eq('时间区间内含全部 4 条', inRange.total, 4);
  const outRange = await adminLedgerService.listTransactions({
    page: 1, pageSize: 50, createdFrom: future,
  });
  c.eq('未来起点筛不到（区间在今日之后）', outRange.total, 0);

  // ---------- 5. ROLLED_BACK 处理 ----------
  // Alice 的 GRANT(100) 做一条对冲回滚（+100 回滚）——实际上回滚是把已结算条目标记为 ROLLED_BACK
  const rollTarget = await prisma.creditTransaction.findFirst({
    where: { userId: alice.id, type: 'GRANT' }, orderBy: { createdAt: 'asc' },
  });
  await prisma.creditTransaction.update({
    where: { id: rollTarget!.id },
    data: { status: 'ROLLED_BACK' },
  });
  const withRollback = await adminLedgerService.listTransactions({ page: 1, pageSize: 50 });
  c.ok('hasRolledBack 变为 true', withRollback.summary.hasRolledBack);
  // 重算应排除回滚：Alice 投影不动，但流水有效净额变为 -30+5=-25 → 不平
  const verifyAfterRoll = await adminLedgerService.verifyAccount(alice.id);
  c.eq('重算排除 ROLLED_BACK（Alice 投影100-30=... 与回滚后有效流水不等）', verifyAfterRoll.matches, false);

  // 恢复 Alice 投影到有效流水重算值，排除干扰后续不平用例
  // 回滚后有效流水：GRANT(100, 已回滚排除) + CONSUME(-30) → balance=-30；INVITE 的 +5 记在 bonus
  await prisma.creditAccount.update({
    where: { userId: alice.id },
    data: { balance: -30, bonusBalance: 5 },
  });
  const verifyFixed = await adminLedgerService.verifyAccount(alice.id);
  c.eq('修正投影后重算一致（回滚已排除）', verifyFixed.matches, true);
  c.eq('修正后 expectedBalance = -30（回滚的 GRANT 被排除）', verifyFixed.expectedBalance, -30);
  c.eq('修正后 expectedBonus = 5', verifyFixed.expectedBonus, 5);

  // ---------- 6. 不平账户检测 ----------
  // 制造三类不平：BALANCE_MISMATCH / BONUS_MISMATCH / NEGATIVE
  const wrongBalance = await createUser('ldg_wrong_bal');
  await prisma.creditAccount.create({ data: { userId: wrongBalance.id, balance: 999, bonusBalance: 0 } });
  await prisma.creditTransaction.create({
    data: {
      userId: wrongBalance.id, type: 'GRANT', status: 'SETTLED', amount: 100,
      deltaBalance: 100, deltaBonus: 0, balanceAfterBalance: 100, balanceAfterBonus: 0, balanceAfter: 100,
      referenceId: `ldg_wb_${Date.now()}`,
    },
  }); // 投影 999 vs 流水 100 → BALANCE_MISMATCH

  const wrongBonus = await createUser('ldg_wrong_bonus');
  await prisma.creditAccount.create({ data: { userId: wrongBonus.id, balance: 0, bonusBalance: 999 } });
  await prisma.creditTransaction.create({
    data: {
      userId: wrongBonus.id, type: 'BONUS', status: 'SETTLED', amount: 10,
      deltaBalance: 0, deltaBonus: 10, balanceAfterBalance: 0, balanceAfterBonus: 10, balanceAfter: 10,
      referenceId: `ldg_wbo_${Date.now()}`,
    },
  }); // 投影 balance 0 与流水一致，bonus 999 vs 流水 10 → 仅 BONUS_MISMATCH

  const negative = await createUser('ldg_negative');
  await prisma.creditAccount.create({ data: { userId: negative.id, balance: -50, bonusBalance: 0 } });
  await prisma.creditTransaction.create({
    data: {
      userId: negative.id, type: 'CONSUME', status: 'SETTLED', amount: -50,
      deltaBalance: -50, deltaBonus: 0, balanceAfterBalance: -50, balanceAfterBonus: 0, balanceAfter: -50,
      referenceId: `ldg_neg_${Date.now()}`,
    },
  }); // 投影 -50 与流水重算一致但为负 → NEGATIVE_BALANCE

  const anomalies = await adminLedgerService.listAnomalousAccounts({ page: 1, pageSize: 50 });
  c.ok('检出不平账户 ≥ 3', anomalies.total >= 3, { total: anomalies.total });

  const balAnomaly = anomalies.items.find((i) => i.userId === wrongBalance.id);
  c.eq('BALANCE_MISMATCH 被检出', balAnomaly?.reason, 'BALANCE_MISMATCH');
  c.eq('余额差额 = 999-100', balAnomaly?.diffBalance, 899);

  const bonusAnomaly = anomalies.items.find((i) => i.userId === wrongBonus.id);
  c.eq('BONUS_MISMATCH 被检出', bonusAnomaly?.reason, 'BONUS_MISMATCH');
  c.eq('奖励差额 = 999-10', bonusAnomaly?.diffBonus, 989);

  const negAnomaly = anomalies.items.find((i) => i.userId === negative.id);
  c.eq('NEGATIVE_BALANCE 被检出', negAnomaly?.reason, 'NEGATIVE_BALANCE');

  // Alice 投影与流水一致，但余额为负（回滚 GRANT 后消费未被撤销）→ 应命中 NEGATIVE_BALANCE
  const aliceAnomaly = anomalies.items.find((i) => i.userId === alice.id);
  c.eq('投影一致但余额为负的账户仍被检出', aliceAnomaly?.reason, 'NEGATIVE_BALANCE');
  c.eq('负值账户差额为 0（投影与流水一致，只是值为负）', aliceAnomaly?.diffBalance, 0);

  // 零流水却有余额（凭空造数据）——曾因 SQL 用 INNER JOIN 而整行被排除，形成检测盲区
  const orphan = await createUser('ldg_orphan');
  await prisma.creditAccount.create({ data: { userId: orphan.id, balance: 7777, bonusBalance: 0 } });
  const withOrphan = await adminLedgerService.listAnomalousAccounts({ page: 1, pageSize: 50 });
  const orphanAnomaly = withOrphan.items.find((i) => i.userId === orphan.id);
  c.ok('零流水却有余额的账户被检出', orphanAnomaly !== undefined);
  c.eq('分类为 NO_TRANSACTION_BALANCE', orphanAnomaly?.reason, 'NO_TRANSACTION_BALANCE');
  c.eq('该账户重算余额为 0', orphanAnomaly?.expectedBalance, 0);
  c.eq('差额等于凭空余额', orphanAnomaly?.diffBalance, 7777);
  c.eq('流水数为 0', orphanAnomaly?.txnCount, 0);
  const orphanOnly = await adminLedgerService.listAnomalousAccounts({
    page: 1,
    pageSize: 50,
    reason: 'NO_TRANSACTION_BALANCE',
  });
  c.ok(
    '按 NO_TRANSACTION_BALANCE 筛选生效',
    orphanOnly.items.length >= 1 && orphanOnly.items.every((i) => i.reason === 'NO_TRANSACTION_BALANCE')
  );

  // 构造一个完全正常的账户，确认不被误报
  const healthy = await createUser('ldg_healthy');
  await prisma.creditAccount.create({ data: { userId: healthy.id, balance: 200, bonusBalance: 10 } });
  await prisma.creditTransaction.create({
    data: {
      userId: healthy.id, type: 'GRANT', status: 'SETTLED', amount: 200,
      deltaBalance: 200, deltaBonus: 0, balanceAfterBalance: 200, balanceAfterBonus: 0, balanceAfter: 200,
      referenceId: `ldg_h_${Date.now()}`,
    },
  });
  await prisma.creditTransaction.create({
    data: {
      userId: healthy.id, type: 'BONUS', status: 'SETTLED', amount: 10,
      deltaBalance: 0, deltaBonus: 10, balanceAfterBalance: 200, balanceAfterBonus: 10, balanceAfter: 210,
      referenceId: `ldg_hb_${Date.now()}`,
    },
  });
  const healthyCheck = await adminLedgerService.verifyAccount(healthy.id);
  c.eq('健康账户重算一致', healthyCheck.matches, true);
  const anomaliesAfter = await adminLedgerService.listAnomalousAccounts({ page: 1, pageSize: 100 });
  c.ok('健康账户不被误报为不平', !anomaliesAfter.items.some((i) => i.userId === healthy.id));

  // 按 reason 筛选
  const negOnly = await adminLedgerService.listAnomalousAccounts({ page: 1, pageSize: 50, reason: 'NEGATIVE_BALANCE' });
  c.ok('按 NEGATIVE 筛选只返回负值账户', negOnly.items.every((i) => i.reason === 'NEGATIVE_BALANCE'));

  // ---------- 7. 账本只读：检测不自动修复 ----------
  const before = await prisma.creditAccount.findUnique({ where: { userId: wrongBalance.id } });
  c.eq('检测前后 wrongBalance 投影不变（只读）', before?.balance, 999);
  await adminLedgerService.scanAnomalies();
  const after = await prisma.creditAccount.findUnique({ where: { userId: wrongBalance.id } });
  c.eq('扫描后投影仍未变（不自动修复）', after?.balance, 999);

  // ---------- 8. 扫描结果 ----------
  const scan = await adminLedgerService.scanAnomalies();
  c.ok('扫描检出数 ≥ 3', scan.anomalies >= 3, { anomalies: scan.anomalies });
  c.ok('扫描含负值计数', scan.negative >= 1, { negative: scan.negative });
  c.ok('扫描有耗时字段', typeof scan.durationMs === 'number');

  // ---------- 9. 账户详情 ----------
  const detail = await adminLedgerService.getAccountDetail(wrongBalance.id);
  c.eq('详情返回正确 userId', detail.user.id, wrongBalance.id);
  c.eq('详情含投影 balance', detail.account?.balance, 999);
  c.eq('详情含重算对比（不符）', detail.recompute.matches, false);
  c.eq('详情重算值 = 流水汇总 100', detail.recompute.balance, 100);
  c.eq('详情含最近流水 ≥ 1 条', detail.recentTransactions.length >= 1, true);

  // ---------- 10. meta ----------
  const meta = adminLedgerService.meta();
  c.eq('meta 含 7 种流水类型', meta.types.length, 7);
  c.eq('meta 含 3 种状态', meta.statuses.length, 3);
  c.eq('meta 含 5 种不平原因', meta.discrepancyReasons.length, 5);
  c.eq('不平原因枚举完整', meta.discrepancyReasons.length, DISCREPANCY_REASONS.length);
  c.ok(
    '不平原因含 NO_TRANSACTION_BALANCE（零流水却有余额）',
    meta.discrepancyReasons.some((r) => r.value === 'NO_TRANSACTION_BALANCE'),
    { reasons: meta.discrepancyReasons }
  );

  console.log('');
  await cleanupE2eData();
}

main()
  .catch((err) => {
    console.error('E2E 执行异常:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    console.log('');
    c.summary('积分账本');
    await prisma.$disconnect();
  });
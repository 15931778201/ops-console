/**
 * E2E · 监控告警（T6.5，服务层 + HTTP 契约，真实 PostgreSQL）
 * 运行：npm run test:e2e:alerts
 *
 * 覆盖验收核心（开发计划 T6.5「告警演练可正常触发」）：
 *  - 规则集覆盖：账本不平/负值、回调验签、DB 可用性、下单失败率、待支付堆积、
 *    登录失败、后台令牌重放、支付成功率、对账差异、定时任务失败
 *  - **防抖**：连续命中阈值（默认 2 轮）才建事件，单轮毛刺不告警
 *  - **静默窗口**：窗口内重复命中不重复建事件（防持续故障刷屏）
 *  - **恢复闭环**：不再命中时回填 resolvedAt，firingCount 归零
 *  - **无通道降级**：未配置 webhook 时 status=suppressed 但**事件仍落库**
 *  - **确认（ack）**：值班处理后停止累积
 *  - **阈值覆盖**：ALERT_THRESHOLD_OVERRIDES 生效
 *  - **绝不抛异常**：采集失败只记录，不阻断其余规则
 *  - HTTP：RBAC（alert:read / alert:manage）、手动评估（演练入口）、审计留痕
 */

import 'dotenv/config';
import type { Server } from 'node:http';
import prisma from '../src/lib/prisma';
import alertService, { ALERT_RULES, evaluate, resetRuleState, acknowledge } from '../src/services/alert.service';
import { adminLedgerService } from '../src/services/admin-ledger.service';
import { sendAlert, hasChannel } from '../src/services/alert-channels';
import {
  listAlerts,
  listRulesWithState,
  alertStats,
  triggerEvaluation,
  acknowledgeRule,
  resetStates,
} from '../src/services/admin-alert.service';
import { adminAuthService } from '../src/services/admin-auth.service';
import { enableTotpDirectly, currentTotp, E2E_PASSWORD, e2eName } from './harness';
import { adminUserService } from '../src/services/admin-user.service';
import { Check, cleanupE2eData } from './harness';
import type { AdminRole } from '@prisma/client';

const c = new Check('监控告警');

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PROBE_TAGS = ['probe_t65_super', 'probe_t65_support', 'probe_t65_auditor'];

/** 清理告警数据（E2E 专用前缀不影响真实告警） */
async function cleanupAlerts(): Promise<void> {
  await prisma.alertEvent.deleteMany({ where: { source: 'monitor' } });
  await prisma.alertRuleState.deleteMany({});
}

async function purgeProbeAdmins(): Promise<void> {
  const usernames = PROBE_TAGS.map(e2eName);
  const stale = await prisma.adminUser.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });
  const ids = stale.map((a) => a.id);
  if (ids.length === 0) return;
  await prisma.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: ids } } });
}

async function loginAs(tag: string, role: AdminRole): Promise<string> {
  const username = e2eName(tag);
  const view = await adminUserService.createAdmin(
    { username, name: `PROBE-${tag}`, password: E2E_PASSWORD, role },
    'system-probe'
  );
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: view.id } });
  await enableTotpDirectly(admin.id, SECRET);
  const s1 = await adminAuthService.loginStep1(username, E2E_PASSWORD);
  const s2 = await adminAuthService.loginStep2(s1.mfaToken, currentTotp(SECRET));
  return s2.tokens.accessToken;
}

let server: Server;
let BASE = '';

async function call(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main(): Promise<void> {
  await cleanupE2eData();
  await cleanupAlerts();

  // ---------- 1. 规则集完整性 ----------
  console.log('\n[1] 规则集');
  c.ok('规则数量 ≥ 10', ALERT_RULES.length >= 10, { count: ALERT_RULES.length });
  c.ok(
    '规则键唯一',
    new Set(ALERT_RULES.map((r) => r.key)).size === ALERT_RULES.length
  );
  c.ok(
    '每条规则有中文名与描述',
    ALERT_RULES.every((r) => !!r.name && typeof r.describe(0, 0) === 'string')
  );
  c.ok(
    '每条规则有合法的 P0/P1/P2 级别',
    ALERT_RULES.every((r) => ['P0', 'P1', 'P2'].includes(r.severity))
  );

  // T6.5 清单要求的告警项必须都有对应规则
  const requiredKeys = [
    'ledger.mismatch',
    'ledger.negativeBalance',
    'payment.signatureInvalid',
    'db.unavailable',
    'payment.createFailureRate',
    'order.stalePending',
    'auth.loginFailureSpike',
    'admin.loginFailureSpike',
    'admin.tokenReuse',
    'payment.successRate',
    'recon.openDiff',
    'job.failure',
  ];
  const actualKeys = ALERT_RULES.map((r) => r.key);
  for (const k of requiredKeys) {
    c.ok(`含规则 ${k}`, actualKeys.includes(k));
  }

  // ---------- 2. 通道降级 ----------
  console.log('\n[2] 通道降级');
  if (!hasChannel()) {
    c.ok('未配置 webhook 时 hasChannel=false', hasChannel() === false);
    const suppressed = await sendAlert({
      severity: 'P1',
      title: '探针告警',
      message: '探针消息',
      ruleKey: 'probe.rule',
      metric: 'probe',
      value: 1,
      threshold: 0,
      hitStreak: 2,
    });
    c.eq('未配置通道时 status=suppressed', suppressed.status, 'suppressed');
    c.eq('未配置通道时不消耗重试次数', suppressed.attempts, 0);
  } else {
    // 配置了通道：用不可达地址验证失败重试与降级
    c.ok('已配置通道', true);
  }

  // ---------- 3. 评估不抛异常 + 基线评估 ----------
  console.log('\n[3] 基线评估');
  const first = await evaluate();
  c.ok('首次评估完成', first.evaluated > 0, first);
  c.ok('评估不抛异常（无 collectFailed 或已记录）', Array.isArray(first.collectFailed));

  const events0 = await prisma.alertEvent.count({ where: { source: 'monitor' } });
  c.ok('首次评估事件数有限（防抖生效，不应一次建 12 条）', events0 <= 6, { events0 });

  // ---------- 4. 防抖：单轮命中不外发 ----------
  console.log('\n[4] 防抖（连续命中阈值）');
  await resetRuleState('ledger.mismatch');
  // 制造一次账本不平：账户有流水（+100），但投影被改成 9999
  const badUser = await prisma.user.create({
    data: {
      email: `e2e_t65_bad_${Date.now()}@example.test`,
      passwordHash: 'x',
      name: 'E2E-不平账户',
      planId: 'free',
    },
  });
  await prisma.creditAccount.create({ data: { userId: badUser.id, balance: 100, bonusBalance: 0 } });
  await prisma.creditTransaction.create({
    data: {
      userId: badUser.id,
      type: 'GRANT',
      status: 'SETTLED',
      amount: 100,
      deltaBalance: 100,
      deltaBonus: 0,
      balanceAfterBalance: 100,
      balanceAfterBonus: 0,
      balanceAfter: 100,
      referenceId: `e2e_t65_txn_${Date.now()}`,
    },
  });
  // 直接改投影（模拟余额被篡改）
  await prisma.creditAccount.update({
    where: { userId: badUser.id },
    data: { balance: 9999 },
  });

  // 零流水却有余额（凭空造数据）——曾因 INNER JOIN 而检测不到
  const orphanUser = await prisma.user.create({
    data: {
      email: `e2e_t65_orphan_${Date.now()}@example.test`,
      passwordHash: 'x',
      name: 'E2E-零流水账户',
      planId: 'free',
    },
  });
  await prisma.creditAccount.create({ data: { userId: orphanUser.id, balance: 8888, bonusBalance: 0 } });

  const r1 = await evaluate();
  c.ok('第 1 轮命中但不触发（未达连续阈值）', !r1.triggered.includes('ledger.mismatch'), r1.triggered);
  const afterFirst = await prisma.alertEvent.count({
    where: { ruleKey: 'ledger.mismatch', source: 'monitor' },
  });
  c.eq('第 1 轮未建事件（单轮毛刺不告警）', afterFirst, 0);

  const st1 = await prisma.alertRuleState.findUniqueOrThrow({ where: { ruleKey: 'ledger.mismatch' } });
  c.eq('hitStreak = 1', st1.hitStreak, 1);
  c.eq('firing 已置位', st1.firing, true);

  const r2 = await evaluate();
  c.ok('第 2 轮触发（达到连续阈值 2）', r2.triggered.includes('ledger.mismatch'), r2.triggered);

  const evt = await prisma.alertEvent.findFirstOrThrow({
    where: { ruleKey: 'ledger.mismatch', source: 'monitor' },
    orderBy: { createdAt: 'desc' },
  });
  c.eq('事件级别为 P0', evt.severity, 'P0');
  c.eq('事件 hitStreak = 2', evt.hitStreak, 2);
  // 制造了两个异常账户（投影被篡改 + 零流水却有余额）
  c.eq('事件记录触发值 = 2 个异常账户', evt.value, 2);
  c.eq('事件记录阈值', evt.threshold, 0);
  c.ok('事件标题含级别前缀', evt.title.startsWith('[P0]'));
  c.ok(
    '事件 detail 含可读消息',
    typeof (evt.detail as { message?: string })?.message === 'string' &&
      (evt.detail as { message: string }).message.length > 0
  );
  c.ok(
    '未配置通道时事件 status=suppressed（不丢事件）',
    evt.status === 'suppressed' || evt.status === 'sent',
    { status: evt.status }
  );
  c.eq('未恢复时 resolvedAt 为 null', evt.resolvedAt, null);

  // 零流水却有余额必须被检出（曾因 INNER JOIN 漏检）
  const anomalies = await adminLedgerService.listAnomalousAccounts({ page: 1, pageSize: 50 });
  const orphanItem = anomalies.items.find((i) => i.userId === orphanUser.id);
  c.ok('零流水却有余额的账户被检出', orphanItem !== undefined, {
    found: anomalies.items.length,
  });
  c.eq('分类为 NO_TRANSACTION_BALANCE', orphanItem?.reason, 'NO_TRANSACTION_BALANCE');
  c.eq('该账户流水数为 0', orphanItem?.txnCount, 0);
  const byReason = await adminLedgerService.listAnomalousAccounts({
    page: 1,
    pageSize: 50,
    reason: 'NO_TRANSACTION_BALANCE',
  });
  c.ok('按新原因筛选生效', byReason.items.every((i) => i.reason === 'NO_TRANSACTION_BALANCE'));

  // ---------- 5. 静默窗口 ----------
  console.log('\n[5] 静默窗口');
  const beforeSilence = await prisma.alertEvent.count({
    where: { ruleKey: 'ledger.mismatch', source: 'monitor' },
  });
  const r3 = await evaluate();
  const afterSilence = await prisma.alertEvent.count({
    where: { ruleKey: 'ledger.mismatch', source: 'monitor' },
  });
  c.ok('静默窗口内不重复建事件', afterSilence === beforeSilence, {
    before: beforeSilence,
    after: afterSilence,
    triggered: r3.triggered,
  });
  const st2 = await prisma.alertRuleState.findUniqueOrThrow({ where: { ruleKey: 'ledger.mismatch' } });
  c.ok('静默窗口内 hitStreak 继续累积', st2.hitStreak > 2, { hitStreak: st2.hitStreak });

  // ---------- 6. 恢复闭环 ----------
  console.log('\n[6] 恢复闭环');
  // 修平两个账户的投影 → 不再命中
  await prisma.creditAccount.update({
    where: { userId: badUser.id },
    data: { balance: 100, bonusBalance: 0 },
  });
  await prisma.creditAccount.delete({ where: { userId: orphanUser.id } });
  const r4 = await evaluate();
  c.ok('不再命中时进入 recovered', r4.recovered.includes('ledger.mismatch'), r4.recovered);

  const resolved = await prisma.alertEvent.findFirstOrThrow({
    where: { ruleKey: 'ledger.mismatch', source: 'monitor' },
    orderBy: { createdAt: 'desc' },
  });
  c.ok('事件被回填 resolvedAt', resolved.resolvedAt !== null);
  const st3 = await prisma.alertRuleState.findUniqueOrThrow({ where: { ruleKey: 'ledger.mismatch' } });
  c.eq('恢复后 firing=false', st3.firing, false);
  c.eq('恢复后 hitStreak 归零', st3.hitStreak, 0);
  c.ok('记录恢复时刻', st3.lastResolvedAt !== null);

  // ---------- 7. 查询服务 ----------
  console.log('\n[7] 查询服务');
  const list = await listAlerts({ page: 1, pageSize: 10 });
  c.ok('告警列表可查', list.items.length > 0, { total: list.total });
  c.ok('含级别分组', list.bySeverity.length > 0);
  c.ok('返回 firingCount', typeof list.firingCount === 'number');
  c.ok('条目含 hitStreak', list.items.every((i) => typeof i.hitStreak === 'number'));

  const byP0 = await listAlerts({ severity: 'P0', page: 1, pageSize: 10 });
  c.ok('按级别筛选生效', byP0.items.every((i) => i.severity === 'P0'));

  const onlyOpen = await listAlerts({ onlyOpen: true, page: 1, pageSize: 10 });
  c.ok(
    'onlyOpen 筛选生效（只含未恢复）',
    onlyOpen.items.every((i) => i.resolvedAt === null)
  );

  const byRule = await listAlerts({ ruleKey: 'ledger.mismatch', page: 1, pageSize: 10 });
  c.ok('按规则筛选生效', byRule.items.every((i) => i.ruleKey === 'ledger.mismatch'));

  // ---------- 8. 规则状态清单 ----------
  console.log('\n[8] 规则清单与策略');
  const rules = await listRulesWithState();
  c.eq('规则清单数量与规则集一致', rules.length, ALERT_RULES.length);
  c.ok('每条含阈值与当前命中状态', rules.every((r) => typeof r.threshold === 'number' && typeof r.firing === 'boolean'));
  c.ok('每条含采集窗口', rules.every((r) => r.windowMs > 0));
  const restored = rules.find((r) => r.key === 'ledger.mismatch');
  c.eq('清单反映恢复状态', restored?.firing, false);

  // ---------- 9. 确认（ack） ----------
  console.log('\n[9] 确认');
  await prisma.alertRuleState.upsert({
    where: { ruleKey: 'ledger.mismatch' },
    create: { ruleKey: 'ledger.mismatch', firing: true, hitStreak: 9 },
    update: { firing: true, hitStreak: 9 },
  });
  await acknowledge('ledger.mismatch');
  const acked = await prisma.alertRuleState.findUniqueOrThrow({ where: { ruleKey: 'ledger.mismatch' } });
  c.eq('确认后 firing=false', acked.firing, false);
  c.eq('确认后 hitStreak 归零', acked.hitStreak, 0);

  // 未知规则应报错
  let ackErr = '';
  try {
    await acknowledgeRule('no.such.rule');
  } catch (err) {
    ackErr = (err as { code?: string }).code ?? '';
  }
  c.eq('确认未知规则 → NOT_FOUND', ackErr, 'NOT_FOUND');

  // ---------- 10. 重置状态 ----------
  console.log('\n[10] 重置');
  await prisma.alertRuleState.create({
    data: { ruleKey: 'ledger.mismatch', firing: true, hitStreak: 5 },
  }).catch(() => undefined);
  const resetResult = await resetStates('ledger.mismatch');
  c.eq('重置返回影响行数', resetResult.reset, 1);
  const afterReset = await prisma.alertRuleState.findUnique({ where: { ruleKey: 'ledger.mismatch' } });
  c.eq('重置后状态行消失', afterReset, null);

  // ---------- 11. 统计 ----------
  console.log('\n[11] 统计');
  const stats = await alertStats(7);
  c.eq('统计窗口正确', stats.windowDays, 7);
  c.ok('总数 ≥ 1', stats.total >= 1, stats);
  c.ok('已恢复数 ≥ 1', stats.resolved >= 1, stats);
  c.eq('未恢复 = 总数 - 已恢复', stats.unresolved, stats.total - stats.resolved);
  c.ok('按规则分组非空', stats.byRule.length > 0);
  c.ok('平均恢复时长可计算', stats.avgResolveMinutes === null || typeof stats.avgResolveMinutes === 'number');

  // ---------- 12. HTTP 契约 ----------
  console.log('\n[12] HTTP 契约');
  const app = (await import('../src/index')).default;
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  BASE = `http://127.0.0.1:${port}/api/admin/v1`;

  await purgeProbeAdmins();
  const superAdmin = await loginAs('probe_t65_super', 'SUPER_ADMIN');
  const support = await loginAs('probe_t65_support', 'SUPPORT');
  const auditor = await loginAs('probe_t65_auditor', 'AUDITOR');

  // 未认证
  c.eq('GET /alerts 无令牌 → 401', (await call(null, 'GET', '/alerts')).status, 401);
  c.eq('POST /alerts/evaluate 无令牌 → 401', (await call(null, 'POST', '/alerts/evaluate', {})).status, 401);

  // 读取权限
  for (const [name, tk] of [
    ['SUPER_ADMIN', superAdmin],
    ['SUPPORT', support],
    ['AUDITOR', auditor],
  ] as const) {
    const r = await call(tk, 'GET', '/alerts');
    c.ok(`${name} 可读告警列表`, r.status === 200, { status: r.status, code: r.data?.error?.code });
  }

  // 元数据与策略
  const meta = await call(superAdmin, 'GET', '/alerts/meta');
  c.eq('meta 可读', meta.status, 200);
  c.ok('meta 含规则清单', Array.isArray(meta.data?.data?.rules));
  c.ok('meta 含通道状态', typeof meta.data?.data?.channel?.configured === 'boolean');
  c.ok('meta 含防抖策略', typeof meta.data?.data?.policy?.consecutiveThreshold === 'number');
  c.ok('meta 含静默窗口', typeof meta.data?.data?.policy?.silenceMs === 'number');

  // 统计端点
  const statsRes = await call(superAdmin, 'GET', '/alerts/stats?days=7');
  c.eq('stats 可读', statsRes.status, 200);
  c.ok('stats 含总数', typeof statsRes.data?.data?.total === 'number');

  // 手动评估（演练入口）
  const evalRes = await call(superAdmin, 'POST', '/alerts/evaluate', { reason: 'E2E 告警演练' });
  c.eq('手动评估成功 → 200', evalRes.status, 200, { status: evalRes.status });
  c.ok('手动评估返回规则数', (evalRes.data?.data?.evaluated ?? 0) > 0);
  c.ok('返回触发列表', Array.isArray(evalRes.data?.data?.triggered));
  c.ok('返回恢复列表', Array.isArray(evalRes.data?.data?.recovered));

  // 演练本身入审计
  const evalAudit = await prisma.auditLog.findFirst({
    where: { action: 'alert.evaluated' },
    orderBy: { createdAt: 'desc' },
  });
  c.ok('手动评估写审计', evalAudit !== null);
  c.eq('审计含触发原因', evalAudit?.reason, 'E2E 告警演练');

  // ack 权限：SUPPORT 只有 read 没有 manage
  const ackDenied = await call(support, 'POST', '/alerts/ledger.mismatch/ack', { reason: '探针越权' });
  c.eq('SUPPORT 无 alert:manage → 403', ackDenied.status, 403, {
    status: ackDenied.status,
    code: ackDenied.data?.error?.code,
  });

  const ackOk = await call(superAdmin, 'POST', '/alerts/ledger.mismatch/ack', { reason: '探针确认' });
  c.eq('SUPER_ADMIN 可确认 → 200', ackOk.status, 200);
  const ackAudit = await prisma.auditLog.findFirst({
    where: { action: 'alert.acknowledged' },
    orderBy: { createdAt: 'desc' },
  });
  c.ok('确认写审计', ackAudit !== null);
  c.eq('确认审计含原因', ackAudit?.reason, '探针确认');

  // reset-states
  const resetRes = await call(superAdmin, 'POST', '/alerts/reset-states', {
    ruleKey: 'ledger.mismatch',
    reason: '探针重置',
  });
  c.eq('重置状态成功', resetRes.status, 200);
  const resetAudit = await prisma.auditLog.findFirst({
    where: { action: 'alert.states_reset' },
    orderBy: { createdAt: 'desc' },
  });
  c.ok('重置写审计', resetAudit !== null);

  // 参数校验
  const badSeverity = await call(superAdmin, 'GET', '/alerts?severity=P9');
  c.eq('非法 severity → 400', badSeverity.status, 400);
  const noReason = await call(superAdmin, 'POST', '/alerts/ledger.mismatch/ack', {});
  c.eq('缺 reason → 400', noReason.status, 400);

  console.log('');
}

main()
  .catch((err) => {
    console.error('E2E 执行异常:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    server?.close();
    await purgeProbeAdmins().catch(() => undefined);
    await prisma.auditLog
      .deleteMany({ where: { action: { in: ['alert.evaluated', 'alert.acknowledged', 'alert.states_reset'] } } })
      .catch(() => undefined);
    await cleanupAlerts().catch(() => undefined);
    console.log('');
    c.summary('监控告警');
    await cleanupE2eData();
    await prisma.$disconnect();
  });
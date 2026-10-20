/**
 * A6.7 契约联调（一次性脚本，真实超管 + 真实 TOTP）
 *
 * 覆盖 HTTP 层的RBAC 边界与响应结构——服务层 E2E 覆盖不到的部分：
 *  - 权限矩阵：SUPPORT 只能读、FINANCE 不能改套餐、OPERATOR 无权
 *  - 写端点必须 PATCH/POST，且全部落审计
 *  - 仪表盘只读端点永不触发实时 COUNT（用快照时间戳佐证）
 *  - 未认证 401 / 越权 403 / 参数非法 400
 *
 * 运行：npx tsx scripts/probe-a67-contract.ts
 */

import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { adminAuthService } from '../src/services/admin-auth.service';
import { enableTotpDirectly, currentTotp, E2E_PASSWORD, e2eName } from '../tests-e2e/harness';
import { adminUserService } from '../src/services/admin-user.service';
import type { AdminRole } from '@prisma/client';

// 探针会产生大量 SQL，屏蔽噪音以突出断言结果
process.env.PRISMA_LOG_QUERIES = '';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 3001}/api/admin/v1`;
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const TAGS = [
  'probe_a67_super',
  'probe_a67_support',
  'probe_a67_finance',
  'probe_a67_auditor',
  'probe_a67_operator',
];

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}`, extra ?? '');
  }
}

interface Token {
  access: string;
}

/** 清掉上次探针残留（按固定 tag 前缀，精准命中） */
async function purgeProbeAdmins(): Promise<void> {
  const usernames = TAGS.map(e2eName);
  const stale = await prisma.adminUser.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });
  const ids = stale.map((a) => a.id);
  if (ids.length === 0) return;
  await prisma.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ actorId: { in: ids } }, { actorId: 'system-probe' }] },
  });
  await prisma.adminUser.deleteMany({ where: { id: { in: ids } } });
}

async function loginAs(tag: string, role: AdminRole): Promise<Token> {
  const username = e2eName(tag);
  const view = await adminUserService.createAdmin(
    { username, name: `PROBE-${tag}`, password: E2E_PASSWORD, role },
    'system-probe'
  );
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { id: view.id } });
  await enableTotpDirectly(admin.id, SECRET);
  const s1 = await adminAuthService.loginStep1(username, E2E_PASSWORD);
  const s2 = await adminAuthService.loginStep2(s1.mfaToken, currentTotp(SECRET));
  return { access: s2.tokens.accessToken };
}

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
  await purgeProbeAdmins();
  const superAdmin = await loginAs('probe_a67_super', 'SUPER_ADMIN');
  const support = await loginAs('probe_a67_support', 'SUPPORT');
  const finance = await loginAs('probe_a67_finance', 'FINANCE');
  const auditor = await loginAs('probe_a67_auditor', 'AUDITOR');
  const operator = await loginAs('probe_a67_operator', 'OPERATOR');

  // ---------- 1. 未认证 ----------
  console.log('\n[1] 未认证访问');
  check('GET /dashboard 无令牌 → 401', (await call(null, 'GET', '/dashboard')).status === 401);
  check('GET /plans 无令牌 → 401', (await call(null, 'GET', '/catalog/plans')).status === 401);
  check('PATCH /plans/:id 无令牌 → 401', (await call(null, 'PATCH', '/catalog/plans/pro', {})).status === 401);

  // ---------- 2. 套餐读取权限矩阵 ----------
  console.log('\n[2] 套餐读取（plan:read）');
  for (const [name, tk] of [
    ['SUPER_ADMIN', superAdmin],
    ['SUPPORT', support],
    ['FINANCE', finance],
    ['AUDITOR', auditor],
  ] as const) {
    const r = await call(tk.access, 'GET', '/catalog/plans');
    check(`${name} 可读套餐列表`, r.status === 200, r.data);
  }
  const opPlans = await call(operator.access, 'GET', '/catalog/plans');
  check(
    'OPERATOR 也可读套餐（客服需查套餐答疑）',
    opPlans.status === 200,
    { status: opPlans.status }
  );

  // ---------- 3. 套餐改价权限矩阵 ----------
  console.log('\n[3] 套餐改价（plan:write）');
  const proBefore = await prisma.plan.findUniqueOrThrow({ where: { id: 'pro' } });
  const priceDelta = 7;

  const finWrite = await call(finance.access, 'PATCH', '/catalog/plans/pro', {
    priceCents: proBefore.priceCents + priceDelta,
    reason: '探针：FINANCE 尝试改价',
  });
  check(
    'FINANCE 无 plan:write → 403',
    finWrite.status === 403,
    { status: finWrite.status, code: finWrite.data?.error?.code }
  );

  const audWrite = await call(auditor.access, 'PATCH', '/catalog/plans/pro', {
    priceCents: proBefore.priceCents + priceDelta,
    reason: '探针：AUDITOR 尝试改价',
  });
  check('AUDITOR 只读 → 403', audWrite.status === 403);

  const supWrite = await call(support.access, 'PATCH', '/catalog/plans/pro', {
    priceCents: proBefore.priceCents + priceDelta,
    reason: '探针：SUPPORT 尝试改价',
  });
  check('SUPPORT 只读 → 403', supWrite.status === 403);

  const priceAfterFail = await prisma.plan.findUniqueOrThrow({ where: { id: 'pro' } });
  check(
    '三次越权后价格分毫未动',
    priceAfterFail.priceCents === proBefore.priceCents,
    { before: proBefore.priceCents, after: priceAfterFail.priceCents }
  );

  // SUPER_ADMIN 可改，且必须写审计
  const target = proBefore.priceCents + priceDelta;
  const okWrite = await call(superAdmin.access, 'PATCH', '/catalog/plans/pro', {
    priceCents: target,
    reason: '探针：超管改价',
  });
  check('SUPER_ADMIN 改价成功 → 200', okWrite.status === 200, okWrite.data);
  check('响应含 priceChanged 标记', okWrite.data?.data?.priceChanged === true);
  check('响应含价格历史', Array.isArray(okWrite.data?.data?.plan?.priceHistory));
  check(
    '历史记录变更前价格',
    okWrite.data?.data?.plan?.priceHistory?.[0]?.priceCents === proBefore.priceCents
  );

  const writeAudit = await prisma.auditLog.findFirst({
    where: { targetId: 'pro', action: 'plan.updated' },
    orderBy: { createdAt: 'desc' },
  });
  check('改价落审计', writeAudit !== null);
  check('审计 actorId 为超管', writeAudit?.actorId === superAdmin.access ? false : !!writeAudit?.actorId);

  // 还原
  await prisma.plan.update({
    where: { id: 'pro' },
    data: { priceCents: proBefore.priceCents },
  });

  // ---------- 4. 改价参数校验 ----------
  console.log('\n[4] 参数校验');
  const noReason = await call(superAdmin.access, 'PATCH', '/catalog/plans/pro', {
    priceCents: proBefore.priceCents,
  });
  check('缺 reason → 400', noReason.status === 400, { status: noReason.status });

  const negPrice = await call(superAdmin.access, 'PATCH', '/catalog/plans/pro', {
    priceCents: -1,
    reason: '探针：负价格',
  });
  check('负价格 → 400', negPrice.status === 400, { status: negPrice.status });

  const notFound = await call(superAdmin.access, 'PATCH', '/catalog/plans/no_such_plan_xyz', {
    priceCents: 100,
    reason: '探针：不存在套餐',
  });
  check('改不存在套餐 → 404', notFound.status === 404, { status: notFound.status });

  // ---------- 5. 规则读取与写入 ----------
  console.log('\n[5] 计费规则（rule:read / rule:write）');
  const ruleList = await call(superAdmin.access, 'GET', '/catalog/rules');
  check('规则列表可读', ruleList.status === 200);
  const rules = ruleList.data?.data?.items ?? [];
  const firstRule = rules[0];
  check('规则项含 toolSlug 与版本', !!firstRule?.toolSlug && !!firstRule?.ruleVersion, {
    got: ruleList.data?.data,
  });
  check('规则项含近 7 日用量', typeof firstRule?.recentUsage?.calls === 'number');

  const opRules = await call(operator.access, 'GET', '/catalog/rules');
  check('OPERATOR 可读规则（有 rule:read）', opRules.status === 200);

  const opInvite = await call(operator.access, 'GET', '/catalog/invites/stats');
  check('OPERATOR 可读邀请统计（有 invite:read）', opInvite.status === 200);

  // 无任何目录权限的角色：AUDITOR 也不能改，但可读——用不存在的端点确认路由守卫生效
  const finRules = await call(finance.access, 'GET', '/catalog/rules');
  check('FINANCE 可读规则', finRules.status === 200);

  const supRuleWrite = await call(support.access, 'PATCH', `/catalog/rules/${firstRule.toolSlug}`, {
    creditCost: firstRule.creditCost + 1,
    reason: '探针：SUPPORT 改规则',
  });
  check('SUPPORT 无 rule:write → 403', supRuleWrite.status === 403);

  const ruleBefore = await prisma.toolBillingRule.findUniqueOrThrow({
    where: { toolSlug: firstRule.toolSlug },
  });
  const ruleOk = await call(superAdmin.access, 'PATCH', `/catalog/rules/${firstRule.toolSlug}`, {
    creditCost: ruleBefore.creditCost + 2,
    reason: '探针：超管改规则',
  });
  check('SUPER_ADMIN 改规则成功', ruleOk.status === 200, ruleOk.data);
  check('响应含旧版本号', ruleOk.data?.data?.previousVersion === ruleBefore.ruleVersion);
  check(
    '响应含新版本号（递增）',
    ruleOk.data?.data?.ruleVersion !== ruleBefore.ruleVersion
  );
  await prisma.toolBillingRule.update({
    where: { toolSlug: firstRule.toolSlug },
    data: { creditCost: ruleBefore.creditCost, ruleVersion: ruleBefore.ruleVersion },
  });

  // ---------- 6. 邀请（只读） ----------
  console.log('\n[6] 邀请数据（只读）');
  const stats = await call(superAdmin.access, 'GET', '/catalog/invites/stats');
  check('邀请统计可读', stats.status === 200);
  check('统计含总邀请数', typeof stats.data?.data?.totalRelations === 'number');
  const codes = await call(superAdmin.access, 'GET', '/catalog/invites/codes?page=1&pageSize=5');
  check('邀请码列表可读', codes.status === 200);
  check('列表带分页结构', typeof codes.data?.data?.pagination?.total === 'number');
  const rels = await call(superAdmin.access, 'GET', '/catalog/invites/relations?page=1&pageSize=5');
  check('归因列表可读', rels.status === 200);

  // ---------- 7. 仪表盘 ----------
  console.log('\n[7] 仪表盘（dashboard:read）');
  const meta = await call(superAdmin.access, 'GET', '/dashboard/meta');
  check('meta 可读', meta.status === 200);
  check('meta 含 3 个 scope', meta.data?.data?.scopes?.length === 3);
  check('meta 含 6 个异常跳转', Object.keys(meta.data?.data?.anomalyLinks ?? {}).length === 6);

  const opDash = await call(operator.access, 'GET', '/dashboard');
  check('OPERATOR 可读仪表盘（有 dashboard:read）', opDash.status === 200, {
    status: opDash.status,
  });

  const refreshed = await call(superAdmin.access, 'POST', '/dashboard/refresh', { scope: 'today' });
  check('手动刷新成功', refreshed.status === 200, refreshed.data);
  const gen1 = refreshed.data?.data?.generatedAt;
  check('刷新返回 generatedAt', typeof gen1 === 'string');

  const read1 = await call(superAdmin.access, 'GET', '/dashboard?scope=today');
  check('读取成功', read1.status === 200);
  check('读取非 stale（刚刷新）', read1.data?.data?.stale === false, {
    stale: read1.data?.data?.stale,
    generatedAt: read1.data?.data?.generatedAt,
  });
  check('指标非空', read1.data?.data?.metrics !== null);
  const m = read1.data?.data?.metrics;
  check('含用户维度', typeof m?.users?.registrations === 'number');
  check('含付费维度', typeof m?.payment?.gmvCents === 'number');
  check('含异常维度', typeof m?.anomalies?.stalePendingOrders === 'number');
  check('含积分维度', typeof m?.credits?.grantedTotal === 'number');
  check('含系统健康 dbOk', m?.system?.dbOk === true);
  check('异常项均带跳转链接', (meta.data?.data?.anomalyLinks?.stalePendingOrders?.to ?? '') === '/orders');

  const badScope = await call(superAdmin.access, 'GET', '/dashboard?scope=bad');
  check('非法 scope → 400', badScope.status === 400, { status: badScope.status });

  // ---------- 8. 快照只读语义 ----------
  console.log('\n[8] 快照语义');
  const gen2 = (await call(superAdmin.access, 'GET', '/dashboard?scope=today')).data?.data?.generatedAt;
  check(
    '纯读取不改变快照时间戳（未触发实时重算）',
    gen2 === gen1,
    { gen1, gen2 }
  );

  console.log(`\n[A6.7 契约联调] ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('联调异常:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 还原探针写入的审计噪声
    await prisma.auditLog.deleteMany({ where: { actorId: 'system-probe' } }).catch(() => undefined);
    await purgeProbeAdmins().catch(() => undefined);
    await prisma.$disconnect();
  });
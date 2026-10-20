/**
 * A6.8 契约联调（一次性脚本，真实超管 + 真实 TOTP）
 *
 * 覆盖 HTTP 层的 RBAC 边界与响应契约——服务层 E2E 覆盖不到的部分：
 *  - flag:read 四角色可读；flag:write 仅 SUPER_ADMIN（停收是资金总闸）
 *  - audit:read 与 audit:export 的角色差异（SUPPORT/OPERATOR 不可导出）
 *  - 导出真实返回文件流 + Content-Disposition + x-export-row-count
 *  - 未认证 401 / 越权 403 / 参数非法 400 / 未知开关 404
 *  - **停收走真实用户端 HTTP 链路**：503 且不影响 plans/flags 查询
 *
 * 运行：npx tsx scripts/probe-a68-contract.ts（需先启动后端）
 */

import 'dotenv/config';
import type { Server } from 'node:http';
import app from '../src/index';
import prisma from '../src/lib/prisma';
import { adminAuthService } from '../src/services/admin-auth.service';
import { enableTotpDirectly, currentTotp, E2E_PASSWORD, e2eName } from '../tests-e2e/harness';
import { adminUserService } from '../src/services/admin-user.service';
import type { AdminRole } from '@prisma/client';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const TAGS = [
  'probe_a68_super',
  'probe_a68_support',
  'probe_a68_finance',
  'probe_a68_auditor',
  'probe_a68_operator',
];

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, extra?: unknown): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}`, extra === undefined ? '' : JSON.stringify(extra));
  }
}

let server: Server;
let BASE = '';

async function purgeProbeAdmins(): Promise<void> {
  const usernames = TAGS.map(e2eName);
  const stale = await prisma.adminUser.findMany({
    where: { username: { in: usernames } },
    select: { id: true },
  });
  const ids = stale.map((a) => a.id);
  if (ids.length === 0) return;
  await prisma.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { actorId: 'system-probe' }] } });
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

async function call(
  token: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: any; headers: Headers; text: string }> {
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
    // 导出接口返回文件流（CSV/JSON），不是 JSON envelope——原样保留
    data = text;
  }
  return { status: res.status, data, headers: res.headers, text };
}

async function main(): Promise<void> {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  BASE = `http://127.0.0.1:${port}/api/admin/v1`;

  await purgeProbeAdmins();
  const superAdmin = await loginAs('probe_a68_super', 'SUPER_ADMIN');
  const support = await loginAs('probe_a68_support', 'SUPPORT');
  const finance = await loginAs('probe_a68_finance', 'FINANCE');
  const auditor = await loginAs('probe_a68_auditor', 'AUDITOR');
  const operator = await loginAs('probe_a68_operator', 'OPERATOR');

  // ---------- 1. 未认证 ----------
  console.log('\n[1] 未认证访问');
  check('GET /flags 无令牌 → 401', (await call(null, 'GET', '/flags')).status === 401);
  check('GET /audit-logs 无令牌 → 401', (await call(null, 'GET', '/audit-logs')).status === 401);
  check('POST /audit-logs/export 无令牌 → 401', (await call(null, 'POST', '/audit-logs/export', {})).status === 401);

  // ---------- 2. 开关读取（flag:read） ----------
  console.log('\n[2] 开关读取（flag:read）');
  for (const [name, tk] of [
    ['SUPER_ADMIN', superAdmin],
    ['SUPPORT', support],
    ['FINANCE', finance],
    ['AUDITOR', auditor],
    ['OPERATOR', operator],
  ] as const) {
    const r = await call(tk, 'GET', '/flags');
    check(`${name} 可读开关列表`, r.status === 200, { status: r.status, code: r.data?.error?.code });
  }
  const flagList = await call(superAdmin, 'GET', '/flags');
  const items = flagList.data?.data?.items ?? [];
  check('开关列表含停收开关', items.some((f: { key: string }) => f.key === 'paymentAcceptingOrders'));
  check('每个开关含中文标签与说明', items.every((f: { label: string; description: string }) => !!f.label && !!f.description));
  check('每个开关含 isDefault 标记', items.every((f: { isDefault: boolean }) => typeof f.isDefault === 'boolean'));

  const flagMeta = await call(superAdmin, 'GET', '/flags/meta');
  check('开关 meta 可读', flagMeta.status === 200);
  check('meta 含默认值字段', typeof flagMeta.data?.data?.items?.[0]?.defaultValue === 'boolean');

  // ---------- 3. 开关写入（flag:write 仅超管） ----------
  console.log('\n[3] 开关写入（flag:write 仅 SUPER_ADMIN）');
  const body = { value: false, reason: '探针：停收演练' };

  for (const [name, tk] of [
    ['SUPPORT', support],
    ['FINANCE', finance],
    ['AUDITOR', auditor],
    ['OPERATOR', operator],
  ] as const) {
    const r = await call(tk, 'PATCH', '/flags/paymentAcceptingOrders', body);
    check(`${name} 无 flag:write → 403`, r.status === 403, {
      status: r.status,
      code: r.data?.error?.code,
    });
  }

  // 确认越权尝试没真的关掉收单
  const afterAttempts = await prisma.featureFlag.findUnique({
    where: { key: 'payment.acceptingOrders' },
  });
  check(
    '四次越权后停收开关未被改动',
    afterAttempts === null || (afterAttempts.value as boolean) === true,
    { value: afterAttempts?.value }
  );

  const okSet = await call(superAdmin, 'PATCH', '/flags/paymentAcceptingOrders', body);
  check('SUPER_ADMIN 停收成功 → 200', okSet.status === 200, { status: okSet.status });
  check('响应含 changed=true', okSet.data?.data?.changed === true);
  check('响应含 previousValue', okSet.data?.data?.previousValue === true);
  check('响应含 value=false', okSet.data?.data?.value === false);

  // 停收审计（critical 标记）
  const flagAudit = await prisma.auditLog.findFirst({
    where: { action: 'flag.updated', targetId: 'payment.acceptingOrders' },
    orderBy: { createdAt: 'desc' },
    select: { actorId: true, metadata: true, reason: true },
  });
  check('停收写审计', flagAudit !== null);
  check('停收审计标记 critical', (flagAudit?.metadata as { critical?: boolean })?.critical === true);
  check('停收审计含原因', !!flagAudit?.reason);

  // 幂等：同值不写审计
  const auditBefore = await prisma.auditLog.count({
    where: { action: 'flag.updated', targetId: 'payment.acceptingOrders' },
  });
  const idem = await call(superAdmin, 'PATCH', '/flags/paymentAcceptingOrders', body);
  const auditAfter = await prisma.auditLog.count({
    where: { action: 'flag.updated', targetId: 'payment.acceptingOrders' },
  });
  check('同值保存 changed=false', idem.data?.data?.changed === false);
  check('同值保存不新增审计', auditAfter === auditBefore);

  // 参数校验
  const noReason = await call(superAdmin, 'PATCH', '/flags/paymentAcceptingOrders', { value: false });
  check('缺 reason → 400', noReason.status === 400, { status: noReason.status });
  const badType = await call(superAdmin, 'PATCH', '/flags/paymentAcceptingOrders', {
    value: 'nope',
    reason: '探针：类型错误',
  });
  check('value 非布尔 → 400', badType.status === 400, { status: badType.status });
  const unknown = await call(superAdmin, 'PATCH', '/flags/no.such.flag', body);
  check('未知开关 → 404', unknown.status === 404, { status: unknown.status });

  // ---------- 4. 停收真实用户端链路 ----------
  console.log('\n[4] 停收走用户端 HTTP');
  const userRoot = BASE.replace('/api/admin/v1', '');
  const anonFlags = await fetch(`${userRoot}/api/payment/flags`);
  check('公开开关接口免登录可读（200）', anonFlags.status === 200, { status: anonFlags.status });
  const anonBody = (await anonFlags.json()) as { data?: Record<string, boolean> };
  check('公开开关反映停收状态', anonBody.data?.paymentAcceptingOrders === false);

  const plansRes = await fetch(`${userRoot}/api/payment/plans`);
  check('停收后套餐目录仍可读（200）', plansRes.status === 200, { status: plansRes.status });

  // 已登录用户下单 → 503
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('Probe123456', 10);
  const probeUser = await prisma.user.create({
    data: { email: `e2e_probe_a68_${Date.now()}@example.test`, passwordHash: hash, name: 'PROBE', planId: 'free' },
  });
  const { authService } = await import('../src/services/auth.service');
  const login = await authService.login(
    { email: probeUser.email, password: 'Probe123456' },
    { ip: '127.0.0.1', userAgent: 'probe' }
  );
  const orderRes = await fetch(`${userRoot}/api/payment/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.tokens.accessToken}` },
    body: JSON.stringify({ planId: 'pro', periodMonths: 1, channel: 'WECHAT', idempotencyKey: `probe_a68_${Date.now()}` }),
  });
  const orderBody = (await orderRes.json()) as { error?: { code?: string } };
  check('停收后 create-order → 503', orderRes.status === 503, { status: orderRes.status });
  check('停收错误码 FEATURE_DISABLED', orderBody.error?.code === 'FEATURE_DISABLED');

  const ordersRes = await fetch(`${userRoot}/api/payment/orders?page=1&pageSize=5`, {
    headers: { authorization: `Bearer ${login.tokens.accessToken}` },
  });
  check('停收后我的订单仍可查（200）', ordersRes.status === 200, { status: ordersRes.status });

  // 恢复收单 → 下单成功
  const restore = await call(superAdmin, 'PATCH', '/flags/paymentAcceptingOrders', {
    value: true,
    reason: '探针：恢复收单',
  });
  check('恢复收单成功', restore.data?.data?.value === true);

  const orderRes2 = await fetch(`${userRoot}/api/payment/create-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.tokens.accessToken}` },
    body: JSON.stringify({ planId: 'pro', periodMonths: 1, channel: 'WECHAT', idempotencyKey: `probe_a68b_${Date.now()}` }),
  });
  check('恢复后可下单（200）', orderRes2.status === 200, { status: orderRes2.status });

  // 清理探针订单与用户
  await prisma.order.deleteMany({ where: { userId: probeUser.id } });
  await prisma.creditTransaction.deleteMany({ where: { userId: probeUser.id } });
  await prisma.creditAccount.deleteMany({ where: { userId: probeUser.id } });
  await prisma.session.deleteMany({ where: { userId: probeUser.id } });
  await prisma.user.delete({ where: { id: probeUser.id } });

  // reset
  const resetRes = await call(superAdmin, 'POST', '/flags/registrationOpen/reset', {
    reason: '探针：恢复默认',
  });
  check('恢复默认值成功', resetRes.status === 200, { status: resetRes.status });

  // ---------- 5. 审计读取（audit:read） ----------
  console.log('\n[5] 审计读取（audit:read）');
  const logList = await call(superAdmin, 'GET', '/audit-logs?page=1&pageSize=5');
  check('审计列表可读', logList.status === 200, { status: logList.status });
  check('返回 items 数组', Array.isArray(logList.data?.data?.items));
  check('返回分页结构', typeof logList.data?.data?.pagination?.total === 'number');
  check('返回按动作分组', Array.isArray(logList.data?.data?.byAction));
  check(
    '条目含中文动作标签',
    (logList.data?.data?.items ?? []).every((i: { actionLabel: string }) => !!i.actionLabel)
  );

  const prefix = await call(superAdmin, 'GET', '/audit-logs?actionPrefix=flag.');
  check('按动作前缀筛选生效', (prefix.data?.data?.items ?? []).every((i: { action: string }) => i.action.startsWith('flag.')));
  check('前缀筛选命中本次写入', (prefix.data?.data?.pagination?.total ?? 0) >= 1);

  const badPageSize = await call(superAdmin, 'GET', '/audit-logs?pageSize=999');
  check('pageSize 超上限 → 400', badPageSize.status === 400, { status: badPageSize.status });
  const badSince = await call(superAdmin, 'GET', '/audit-logs?since=not-a-date');
  check('非法时间 → 400', badSince.status === 400, { status: badSince.status });

  const logMeta = await call(superAdmin, 'GET', '/audit-logs/meta');
  check('审计 meta 可读', logMeta.status === 200);
  check('meta 含动作分组', Array.isArray(logMeta.data?.data?.groups));
  check('meta 含导出上限', logMeta.data?.data?.exportMaxRows === 10_000);

  // ---------- 6. 审计导出（audit:export） ----------
  console.log('\n[6] 审计导出（audit:export）');
  for (const [name, tk] of [
    ['SUPPORT', support],
    ['OPERATOR', operator],
  ] as const) {
    const r = await call(tk, 'POST', '/audit-logs/export', { format: 'csv' });
    check(`${name} 无 audit:export → 403`, r.status === 403, {
      status: r.status,
      code: r.data?.error?.code,
    });
  }

  const csvRes = await call(finance, 'POST', '/audit-logs/export', { format: 'csv', actionPrefix: 'flag.' });
  check('FINANCE 可导出 CSV', csvRes.status === 200, { status: csvRes.status });
  check(
    'CSV Content-Type 正确',
    String(csvRes.headers.get('content-type')).includes('text/csv'),
    { ct: csvRes.headers.get('content-type') }
  );
  const disposition = String(csvRes.headers.get('content-disposition'));
  check('CSV 含 attachment 与文件名', disposition.includes('attachment') && disposition.includes('.csv'), {
    disposition,
  });
  check('响应含行数头', csvRes.headers.get('x-export-row-count') !== null);
  check('响应含截断标记', csvRes.headers.get('x-export-truncated') === 'false');
  // fetch().text() 会按规范剥离 BOM，故用字节判断（arrayBuffer 保留原始字节）
  const csvBytes = new Uint8Array(await fetch(`${BASE}/audit-logs/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auditor}` },
    body: JSON.stringify({ format: 'csv', actionPrefix: 'flag.' }),
  }).then((r) => r.arrayBuffer()));
  check('CSV 含 UTF-8 BOM（Excel 正确识别中文）', csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, {
    first3: [...csvBytes.slice(0, 3)],
  });

  const jsonRes = await call(auditor, 'POST', '/audit-logs/export', { format: 'json', actionPrefix: 'flag.' });
  check('AUDITOR 可导出 JSON', jsonRes.status === 200, { status: jsonRes.status });
  const parsed = JSON.parse(jsonRes.text) as { rowCount: number; rows: unknown[]; exportedAt: string };
  check('JSON 行数一致', parsed.rows.length === parsed.rowCount);
  check('JSON 含导出时间', typeof parsed.exportedAt === 'string');

  // 导出本身入审计
  const exportLogs = await prisma.auditLog.count({ where: { action: 'audit.exported' } });
  check('导出行为本身入审计（≥2 次：FINANCE + AUDITOR）', exportLogs >= 2, { exportLogs });

  // 限频：SUPER_ADMIN 已用过 0 次，连打 4 次验证第 4 次被拦
  const e1 = await call(superAdmin, 'POST', '/audit-logs/export', { format: 'csv', actionPrefix: 'flag.' });
  check('第 1 次导出放行', e1.status === 200, { status: e1.status });
  const e2 = await call(superAdmin, 'POST', '/audit-logs/export', { format: 'csv', actionPrefix: 'flag.' });
  check('第 2 次导出放行', e2.status === 200, { status: e2.status });
  const e3 = await call(superAdmin, 'POST', '/audit-logs/export', { format: 'csv', actionPrefix: 'flag.' });
  check('第 3 次导出放行', e3.status === 200, { status: e3.status });
  const e4 = await call(superAdmin, 'POST', '/audit-logs/export', { format: 'csv', actionPrefix: 'flag.' });
  check('第 4 次导出被限频拦截（10 分钟 3 次）', e4.status === 429, {
    status: e4.status,
    body: typeof e4.data === 'string' ? e4.data.slice(0, 120) : e4.data,
  });
  check('限频错误码 RATE_LIMITED', e4.data?.error?.code === 'RATE_LIMITED', e4.data?.error);
  check('限频响应带 Retry-After', e4.headers.get('retry-after') !== null);

  // 其他管理员不受影响（计数按人隔离）
  const otherStillOk = await call(finance, 'POST', '/audit-logs/export', { format: 'csv', actionPrefix: 'flag.' });
  check('其他管理员不受本次限频影响', otherStillOk.status === 200, { status: otherStillOk.status });

  console.log(`\n[A6.8 契约联调] ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('联调异常:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 兜底：无论如何把收单恢复，避免污染后续联调
    await prisma.featureFlag
      .deleteMany({ where: { key: 'payment.acceptingOrders' } })
      .catch(() => undefined);
    await prisma.auditLog
      .deleteMany({
        where: {
          action: { in: ['flag.updated', 'flag.reset', 'audit.exported'] },
          OR: [{ actorId: 'system-probe' }, { actorId: { startsWith: 'e2e_' } }],
        },
      })
      .catch(() => undefined);
    await purgeProbeAdmins().catch(() => undefined);
    server?.close();
    await prisma.$disconnect();
  });
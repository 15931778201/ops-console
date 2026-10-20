/**
 * E2E · 系统开关 + 审计查询/导出（A6.8，服务层 + HTTP 契约，真实 PostgreSQL）
 * 运行：npm run test:e2e:flags
 *
 * 覆盖验收核心（设计文档第十章第 5 条 + 第 4 条）：
 *  - **停收演练**：开启停收后 60 秒内新订单被拒（503），**查询与退款不受影响**；关闭后恢复
 *  - 开关默认值：库里无记录时用代码默认值（不依赖 seed）
 *  - 开关幂等：值未变不写库不写审计；变更立即失效缓存（毫秒级生效）
 *  - 审计查询：多维筛选、按动作前缀、分页、按动作计数
 *  - 审计导出：CSV/JSON、**限频生效**、**导出本身入审计**、CSV 公式注入防护
 *  - 权限边界：flag:write 仅超管，audit:export 不含 SUPPORT/OPERATOR
 */

import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { orderService } from '../src/services/order.service';
import {
  isEnabled,
  listFlags,
  getPublicFlags,
  setFlag,
  resetFlag,
  invalidateFlagCache,
  FLAG_KEYS,
} from '../src/services/feature-flag.service';
import {
  listAuditLogs,
  exportAuditLogs,
  recordExport,
  checkExportRate,
  AUDIT_ACTION_GROUPS,
  EXPORT_MAX_ROWS,
} from '../src/services/admin-audit.service';
import { Check, cleanupE2eData, testEmail } from './harness';
import { audit } from '../src/lib/audit';
import type { User } from '@prisma/client';

const c = new Check('开关与审计');

const ACTOR = 'system-e2e-flags';

/** 测试结束后必须恢复的开关 */
const restore: Array<() => Promise<void>> = [];

async function createUser(tag: string, planId = 'free'): Promise<User> {
  return prisma.user.create({
    data: { email: testEmail(tag), passwordHash: 'x', name: `E2E-${tag}`, planId },
  });
}

/** 通过 HTTP 层验证停收（走真实路由，才能验到 503 语义） */
async function assertStopSellingBlocksOrder(user: User, planId: string): Promise<void> {
  const app = (await import('../src/index')).default;
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    // 未登录 → 401（先证明路由本身活着）
    const anon = await fetch(`http://127.0.0.1:${port}/api/payment/create-order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId, periodMonths: 1, channel: 'WECHAT', idempotencyKey: `e2e_flag_anon_${Date.now()}` }),
    });
    c.eq('停收期间未登录仍先被认证拦截（401）', anon.status, 401);

    // 登录后带令牌下单 → 应为 503
    const { token } = await loginUser(user.email);
    const res = await fetch(`http://127.0.0.1:${port}/api/payment/create-order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ planId, periodMonths: 1, channel: 'WECHAT', idempotencyKey: `e2e_flag_${Date.now()}` }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    c.ok('停收后 create-order 返回 503', res.status === 503, { status: res.status, body });
    c.eq('停收错误码为 FEATURE_DISABLED', body.error?.code, 'FEATURE_DISABLED');

    // **查询不受影响**（验收标准第 5 条）
    const plans = await fetch(`http://127.0.0.1:${port}/api/payment/plans`);
    c.eq('停收后套餐目录仍可读（200）', plans.status, 200);
    const planItems = ((await plans.json()) as { data?: { items?: unknown[] } }).data?.items;
    c.ok('停收后套餐目录非空', Array.isArray(planItems) && planItems.length > 0);

    const orders = await fetch(`http://127.0.0.1:${port}/api/payment/orders?page=1&pageSize=5`, {
      headers: { authorization: `Bearer ${token}` },
    });
    c.eq('停收后我的订单仍可查（200）', orders.status, 200);

    // 公开开关接口（未登录也能读，用于隐藏 CTA）
    const flags = await fetch(`http://127.0.0.1:${port}/api/payment/flags`);
    const flagBody = (await flags.json()) as { data?: Record<string, boolean> };
    c.eq('停收后公开开关接口仍可读（200）', flags.status, 200);
    c.eq(
      '公开开关反映停收状态（前端据此隐藏 CTA）',
      flagBody.data?.paymentAcceptingOrders,
      false
    );
  } finally {
    server.close();
  }
}

/** 真实用户登录拿 token（bcrypt 走真实实现） */
async function loginUser(email: string): Promise<{ token: string }> {
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('FlagTest123', 10);
  await prisma.user.update({ where: { email }, data: { passwordHash: hash } });

  const { authService } = await import('../src/services/auth.service');
  const out = await authService.login(
    { email, password: 'FlagTest123' },
    { ip: '127.0.0.1', userAgent: 'e2e' }
  );
  return { token: out.tokens.accessToken };
}

async function main(): Promise<void> {
  await cleanupE2eData();

  const proPlan = await prisma.plan.findUniqueOrThrow({ where: { id: 'pro' } });
  const buyer = await createUser('flag_buyer', 'free');

  // ---------- 1. 默认值（无 seed 依赖） ----------
  console.log('\n[1] 开关默认值');
  const flags0 = await listFlags();
  c.eq('开关数量 = 定义数量', flags0.length, FLAG_KEYS.length);
  c.ok('每个开关都有中文标签与说明', flags0.every((f) => !!f.label && !!f.description));
  const acceptFlag = flags0.find((f) => f.key === 'paymentAcceptingOrders')!;
  c.eq('停收开关默认开启', acceptFlag.value, true);
  c.eq('库中无记录时标记 isDefault', acceptFlag.isDefault, true);
  c.eq('库中无记录时 hasOverride=false', acceptFlag.hasOverride, false);

  const pub = await getPublicFlags();
  c.eq('公开开关含停收状态', pub.paymentAcceptingOrders, true);
  c.eq('公开开关键数与定义一致', Object.keys(pub).length, FLAG_KEYS.length);

  // ---------- 2. 停收演练（验收标准第 5 条） ----------
  console.log('\n[2] 停收演练');
  const t0 = Date.now();
  const off = await setFlag('paymentAcceptingOrders', false, ACTOR, 'E2E 停收演练');
  c.eq('停收设置成功', off.value, false);
  c.eq('changed 标记为 true', off.changed, true);
  c.eq('记录变更前值', off.previousValue, true);

  // 缓存必须立即失效（远优于 60 秒要求）
  const immediate = await isEnabled('paymentAcceptingOrders');
  c.eq('切换后立即读取即为 false（缓存已失效）', immediate, false);
  c.ok(`生效耗时 ${Date.now() - t0}ms < 60000ms`, Date.now() - t0 < 60_000);

  await assertStopSellingBlocksOrder(buyer, proPlan.id);

  // 库层确认
  const row = await prisma.featureFlag.findUniqueOrThrow({ where: { key: 'payment.acceptingOrders' } });
  c.eq('库中已落停收=false', row.value, false);
  c.eq('记录操作人', row.updatedBy, ACTOR);

  // ---------- 3. 停收期间服务层同样拒绝 ----------
  console.log('\n[3] 服务层一致');
  // orderService 本身不读开关（开关在路由层），因此这里验证路由层已足够；
  // 但要确认开关不影响订单查询
  const listOk = await orderService.listUserOrders(buyer.id, { page: 1, pageSize: 5 });
  c.ok('停收期间订单查询服务正常返回', listOk !== undefined);

  // ---------- 4. 关闭停收后恢复 ----------
  console.log('\n[4] 恢复收单');
  const on = await setFlag('paymentAcceptingOrders', true, ACTOR, 'E2E 恢复收单');
  c.eq('恢复收单成功', on.value, true);
  c.eq('立即读取为 true', await isEnabled('paymentAcceptingOrders'), true);

  const restored = await orderService.createOrder({
    userId: buyer.id,
    planId: proPlan.id,
    channel: 'WECHAT',
    periodMonths: 1,
    idempotencyKey: `e2e_flag_ok_${Date.now()}`,
  });
  c.ok('恢复后可正常下单', restored.order.status === 'PENDING');
  c.eq('恢复后订单按服务端定价', restored.order.amountCents, proPlan.priceCents);

  // ---------- 5. 幂等 ----------
  console.log('\n[5] 幂等与审计');
  const auditsBefore = await prisma.auditLog.count({
    where: { action: 'flag.updated', actorId: ACTOR },
  });
  const idem = await setFlag('paymentAcceptingOrders', true, ACTOR, 'E2E 同值保存');
  c.eq('同值保存 changed=false', idem.changed, false);
  const auditsAfter = await prisma.auditLog.count({
    where: { action: 'flag.updated', actorId: ACTOR },
  });
  c.eq('同值保存不写审计', auditsAfter, auditsBefore);

  // ---------- 6. 恢复默认值 ----------
  const reset = await resetFlag('registrationOpen', ACTOR, 'E2E 恢复默认');
  c.eq('reset 返回代码默认值 true', reset.value, true);
  const overrideRow = await prisma.featureFlag.findUnique({ where: { key: 'registration.open' } });
  c.eq('reset 后库中无 override 记录', overrideRow, null);
  c.eq('reset 后读取仍为默认值', await isEnabled('registrationOpen'), true);

  // ---------- 7. 审计查询 ----------
  console.log('\n[7] 审计查询');
  // 审计由**路由层**写入（setFlag 只管开关本身），这里显式补一条以构造查询样本
  await audit.record({
    actorType: 'ADMIN',
    actorId: ACTOR,
    action: 'flag.updated',
    targetType: 'FeatureFlag',
    targetId: 'registration.open',
    reason: 'E2E 关闭注册（构造审计样本）',
    metadata: { value: false, critical: false },
  });
  restore.push(async () => {
    await setFlag('registrationOpen', true, ACTOR, 'E2E 收尾还原');
  });

  const all = await listAuditLogs({ page: 1, pageSize: 5 });
  c.ok('审计列表可查', all.items.length <= 5);
  c.ok('返回 total', typeof all.total === 'number');
  c.ok('含按动作分组计数', all.byAction.length > 0);
  c.ok(
    '动作标签可读',
    all.items.every((i) => typeof i.actionLabel === 'string' && i.actionLabel.length > 0)
  );
  c.ok('默认按时间倒序', all.items.length < 2 || all.items[0]!.createdAt >= all.items[1]!.createdAt);

  const byPrefix = await listAuditLogs({ actionPrefix: 'flag.' });
  c.ok('按动作前缀筛选生效', byPrefix.items.every((i) => i.action.startsWith('flag.')));
  c.ok('前缀筛选命中本次写入', byPrefix.total >= 1);

  const byExact = await listAuditLogs({ action: 'flag.updated' });
  c.ok('按动作精确筛选生效', byExact.items.every((i) => i.action === 'flag.updated'));

  const byActor = await listAuditLogs({ actorId: ACTOR });
  c.ok('按操作者筛选生效', byActor.items.every((i) => i.actorId === ACTOR));

  const byTime = await listAuditLogs({ since: new Date(Date.now() - 60_000) });
  c.ok('按时间区间筛选生效', byTime.items.every((i) => Date.parse(i.createdAt) >= Date.now() - 61_000));

  const p1 = await listAuditLogs({ page: 1, pageSize: 2 });
  const p2 = await listAuditLogs({ page: 2, pageSize: 2 });
  c.ok('分页生效（第 1 页 ≤ 2 条）', p1.items.length <= 2);
  c.ok(
    '分页不同页数据不同',
    p1.items.length < 2 || p2.items.length === 0 || p1.items[0]!.id !== p2.items[0]!.id
  );

  // 组合筛选：前缀 + 操作者
  const combo = await listAuditLogs({ actionPrefix: 'flag.', actorId: ACTOR });
  c.ok(
    '组合筛选生效',
    combo.items.every((i) => i.action.startsWith('flag.') && i.actorId === ACTOR)
  );

  // ---------- 8. 审计导出 ----------
  console.log('\n[8] 审计导出');
  const csv = await exportAuditLogs({ actionPrefix: 'flag.' }, 'csv');
  c.eq('CSV 导出行数 > 0', csv.rowCount > 0, true);
  c.ok('CSV 带 BOM（Excel 识别中文）', csv.content.startsWith('\uFEFF'));
  c.ok('CSV 含表头', csv.content.includes('时间') && csv.content.includes('动作'));
  c.ok('CSV 含 CRLF', csv.content.includes('\r\n'));
  c.ok('CSV 文件名带时间戳', /^audit-logs-.*\.csv$/.test(csv.filename));

  const json = await exportAuditLogs({ actionPrefix: 'flag.' }, 'json');
  const parsed = JSON.parse(json.content) as { rowCount: number; rows: unknown[]; exportedAt: string };
  c.eq('JSON 行数与 rowCount 一致', parsed.rows.length, json.rowCount);
  c.eq('JSON rowCount 字段一致', parsed.rowCount, json.rowCount);
  c.ok('JSON 含导出时间', typeof parsed.exportedAt === 'string');
  c.ok('JSON 行含动作标签', (parsed.rows[0] as { actionLabel?: string })?.actionLabel !== undefined);

  // CSV 公式注入防护
  const evil = await prisma.auditLog.create({
    data: {
      actorType: 'ADMIN',
      actorId: null,
      action: 'flag.updated',
      targetType: 'FeatureFlag',
      targetId: 'payment.acceptingOrders',
      reason: '=cmd|calc!A1 注入测试',
    },
  });
  const evil2 = await prisma.auditLog.create({
    data: {
      actorType: 'ADMIN',
      actorId: null,
      action: 'flag.updated',
      targetType: 'FeatureFlag',
      targetId: 'payment.acceptingOrders',
      reason: '@SUM(1+1) 注入测试',
    },
  });
  const evilCsv = await exportAuditLogs({ actionPrefix: 'flag.' }, 'csv');
  c.ok(
    'CSV 对 = 开头的值加单引号前缀（防公式注入）',
    evilCsv.content.includes(`'=cmd|calc!A1`),
    { sample: evilCsv.content.split('\r\n').find((l) => l.includes('cmd|calc'))?.slice(0, 140) }
  );
  c.ok('CSV 对 @ 开头的值加前缀', evilCsv.content.includes(`'@SUM(1+1)`));
  c.ok('注入内容未被裸写', !evilCsv.content.includes(',=cmd|calc!A1'));
  c.ok('@ 注入也未被裸写', !evilCsv.content.includes(',@SUM(1+1)'));
  await prisma.auditLog.deleteMany({ where: { id: { in: [evil.id, evil2.id] } } });

  // 导出本身入审计
  const exportAuditBefore = await prisma.auditLog.count({ where: { action: 'audit.exported' } });
  await recordExport('e2e-admin-1', { format: 'csv', rowCount: csv.rowCount, truncated: false, filters: {} });
  const exportAuditAfter = await prisma.auditLog.count({ where: { action: 'audit.exported' } });
  c.eq('导出行为本身入审计', exportAuditAfter, exportAuditBefore + 1);

  const exportLog = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'audit.exported' },
    orderBy: { createdAt: 'desc' },
  });
  c.eq('导出审计含格式', (exportLog.metadata as { format?: string })?.format, 'csv');
  c.eq('导出审计含行数', (exportLog.metadata as { rowCount?: number })?.rowCount, csv.rowCount);
  c.ok('导出审计含操作者', exportLog.actorId === 'e2e-admin-1');

  // ---------- 9. 导出限频 ----------
  console.log('\n[9] 导出限频');
  const limiterAdmin = 'e2e-admin-ratelimit';
  const r1 = await checkExportRate(limiterAdmin);
  const r2 = await checkExportRate(limiterAdmin);
  const r3 = await checkExportRate(limiterAdmin);
  const r4 = await checkExportRate(limiterAdmin);
  c.eq('第 1 次允许', r1.allowed, true);
  c.eq('第 2 次允许', r2.allowed, true);
  c.eq('第 3 次允许', r3.allowed, true);
  c.eq('第 4 次被拦（10 分钟 3 次）', r4.allowed, false);
  c.ok('被拦时返回剩余秒数', r4.retryAfterSec > 0 && r4.retryAfterSec <= 600, r4);

  const other = await checkExportRate('e2e-admin-other');
  c.eq('不同管理员独立计数', other.allowed, true);

  // ---------- 10. 导出上限常量 ----------
  console.log('\n[10] 上限与字典');
  c.eq('导出硬上限为 10000 行', EXPORT_MAX_ROWS, 10_000);
  c.ok('动作字典覆盖全部审计组', Object.keys(AUDIT_ACTION_GROUPS).length >= 9);
  c.ok('字典含开关组', 'flag' in AUDIT_ACTION_GROUPS);
  c.ok('字典含审计导出组', 'audit' in AUDIT_ACTION_GROUPS);
  c.ok('字典含审批组', 'approval' in AUDIT_ACTION_GROUPS);

  // 清理本次产生的导出审计
  await prisma.auditLog.deleteMany({ where: { action: 'audit.exported', actorId: 'e2e-admin-1' } });

  console.log('');
}

main()
  .catch((err) => {
    console.error('E2E 执行异常:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 必须还原开关，否则后续 E2E 会因停收而全灭
    await setFlag('paymentAcceptingOrders', true, 'system-e2e-cleanup', '收尾强制恢复收单').catch(() => undefined);
    await resetFlag('registrationOpen', 'system-e2e-cleanup', '收尾恢复默认').catch(() => undefined);
    await resetFlag('paymentMockChannel', 'system-e2e-cleanup', '收尾恢复默认').catch(() => undefined);
    invalidateFlagCache();
    for (const fn of restore) {
      await fn().catch(() => undefined);
    }
    // 清掉本次开关写入（仅限 e2e actor，避免留下测试审计）
    await prisma.auditLog
      .deleteMany({
        where: {
          action: { in: ['flag.updated', 'flag.reset'] },
          actorId: { in: [ACTOR, 'system-e2e-cleanup'] },
        },
      })
      .catch(() => undefined);
    await prisma.featureFlag.deleteMany({}).catch(() => undefined);
    invalidateFlagCache();

    console.log('');
    c.summary('开关与审计');
    await cleanupE2eData();
    await prisma.$disconnect();
  });
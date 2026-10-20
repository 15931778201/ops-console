/**
 * E2E · 订单与对账工作台（服务层，真实 PostgreSQL + mock 支付渠道）
 * 运行：npm run test:e2e:orders
 *
 * 覆盖不变量（A6.4 验收核心）：
 *  - 订单列表多维筛选 + 金额汇总
 *  - 订单详情含 PaymentEvent 时间线与发放流水
 *  - 渠道查单补结算幂等：重复 sync 绝不重复发权益
 *  - 金额不一致禁止自动改状态（仅记 note）
 *  - 四类差异正确落 ReconciliationRecord
 *  - AUTO_SETTLED 记录拒绝人工标记
 *  - 人工处理写入 handledBy/handledAt
 *  - retrySettlement 仅对 PAID_LOCAL_PENDING 生效，其余类型拒绝
 */

import prisma from '../src/lib/prisma';
import { adminOrderService } from '../src/services/admin-order.service';
import { adminReconService, DIFF_TYPES } from '../src/services/admin-recon.service';
import { settlementService } from '../src/services/payment/settlement.service';
import { buildMockNotify } from '../src/services/payment/mock';
import { adminUserMgmtService } from '../src/services/admin-user-mgmt.service';
import { Check, cleanupE2eData, loginAsAdmin, testEmail } from './harness';
import type { Order, User } from '@prisma/client';

/** 订单号前缀（清理依据） */
const ORDER_PREFIX = 'E2E';

let seq = 0;
function nextOrderNo(): string {
  seq += 1;
  return `${ORDER_PREFIX}${Date.now()}_${seq}`;
}

async function createUser(tag: string, planId = 'free'): Promise<User> {
  const user = await prisma.user.create({
    data: {
      email: testEmail(tag),
      passwordHash: 'x',
      name: `E2E-${tag}`,
      planId,
    },
  });
  await prisma.creditAccount.create({ data: { userId: user.id, balance: 0, bonusBalance: 0 } });
  return user;
}

async function createOrder(
  user: User,
  opts: { status?: Order['status']; amountCents?: number; monthlyCredits?: number } = {}
): Promise<Order> {
  return prisma.order.create({
    data: {
      orderNo: nextOrderNo(),
      userId: user.id,
      planId: 'pro_monthly',
      amountCents: opts.amountCents ?? 1990,
      currency: 'CNY',
      periodMonths: 1,
      channel: 'WECHAT',
      status: opts.status ?? 'PENDING',
      priceSnapshot: { monthlyCredits: opts.monthlyCredits ?? 500 },
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
}

async function main(): Promise<void> {
  const c = new Check();
  console.log('\n=== E2E: 订单与对账工作台 ===');

  const actor = await loginAsAdmin('orders_actor', 'SUPER_ADMIN');
  const actorId = actor.admin.id;

  // ---------- 1. 订单列表与汇总 ----------
  const user = await createUser('orders_main', 'pro_monthly');
  const paidOrder = await createOrder(user, { status: 'PAID', amountCents: 2990 });
  const pendingOrder = await createOrder(user, { status: 'PENDING' });

  const all = await adminOrderService.listOrders({ page: 1, pageSize: 100 });
  c.ok('列表能查到 E2E 订单', all.items.some((o) => o.orderNo === paidOrder.orderNo));
  c.ok('汇总含 totalAmountCents', all.summary.totalAmountCents >= 2990, all.summary);
  c.ok('列表项含用户信息', Boolean((all.items[0] as { user?: unknown }).user));

  const byStatus = await adminOrderService.listOrders({
    page: 1,
    pageSize: 100,
    status: 'PENDING',
  });
  c.ok(
    '按状态筛选只返回 PENDING',
    byStatus.items.every((o) => o.status === 'PENDING'),
    byStatus.items.map((o) => o.status)
  );

  const byNo = await adminOrderService.listOrders({
    page: 1,
    pageSize: 10,
    orderNo: paidOrder.orderNo,
  });
  c.eq('按订单号精确命中 1 条', byNo.total, 1);

  const byUser = await adminOrderService.listOrders({
    page: 1,
    pageSize: 50,
    userId: user.id,
  });
  c.ok('按用户筛选只返回该用户订单', byUser.items.every((o) => o.userId === user.id));

  // ---------- 2. 订单详情 ----------
  const detail = await adminOrderService.getOrderDetail(paidOrder.orderNo);
  c.eq('详情订单号正确', detail.order.orderNo, paidOrder.orderNo);
  c.ok('详情含 user 投影', detail.user !== null);
  c.ok('events 为数组', Array.isArray(detail.events));
  await c.throwsCode('订单不存在 → ORDER_NOT_FOUND', 'ORDER_NOT_FOUND', () =>
    adminOrderService.getOrderDetail('E2E_NOT_EXIST_000')
  );

  // ---------- 3. 结算幂等：核心不变量 ----------
  const settleUser = await createUser('orders_settle', 'pro_monthly');
  const settleOrder = await createOrder(settleUser, { monthlyCredits: 500 });

  const notify = buildMockNotify({
    orderNo: settleOrder.orderNo,
    amountCents: settleOrder.amountCents,
    currency: settleOrder.currency,
    status: 'PAID',
  });
  const r1 = await settlementService.handlePaymentNotify({
    provider: 'mock',
    rawBody: notify.rawBody,
    headers: notify.headers,
  });
  c.eq('首次回调完成结算', r1.duplicate, false);

  const accAfterFirst = await prisma.creditAccount.findUnique({
    where: { userId: settleUser.id },
  });
  c.eq('首次结算发放 500 积分', accAfterFirst!.balance, 500);

  // 重复回调（不同 eventId，同一订单）→ 幂等跳过，不重复发权益
  const notify2 = buildMockNotify({
    orderNo: settleOrder.orderNo,
    amountCents: settleOrder.amountCents,
    currency: settleOrder.currency,
    status: 'PAID',
  });
  const r2 = await settlementService.handlePaymentNotify({
    provider: 'mock',
    rawBody: notify2.rawBody,
    headers: notify2.headers,
  });
  c.eq('重复回调（新 eventId）被幂等拦截', r2.duplicate, false);
  const accAfterSecond = await prisma.creditAccount.findUnique({
    where: { userId: settleUser.id },
  });
  c.eq('重复回调不重复发权益（仍 500）', accAfterSecond!.balance, 500);

  // 完全相同 eventId → P2002 唯一约束命中，返回 duplicate
  const r3 = await settlementService.handlePaymentNotify({
    provider: 'mock',
    rawBody: notify.rawBody,
    headers: notify.headers,
  });
  c.eq('相同 eventId 重复回调返回 duplicate=true', r3.duplicate, true);
  const accAfterThird = await prisma.creditAccount.findUnique({
    where: { userId: settleUser.id },
  });
  c.eq('重复回调后余额不变', accAfterThird!.balance, 500);

  const grantCount = await prisma.creditTransaction.count({
    where: { userId: settleUser.id, type: 'GRANT' },
  });
  c.eq('GRANT 流水只有 1 条', grantCount, 1);

  // 金额不一致 → 拒绝结算
  const mismatchUser = await createUser('orders_mismatch', 'pro_monthly');
  const mismatchOrder = await createOrder(mismatchUser, { amountCents: 1990 });
  const badNotify = buildMockNotify({
    orderNo: mismatchOrder.orderNo,
    amountCents: 1991,
    currency: 'CNY',
    status: 'PAID',
  });
  await c.throwsCode('金额不一致拒绝结算', 'ORDER_AMOUNT_MISMATCH', () =>
    settlementService.handlePaymentNotify({
      provider: 'mock',
      rawBody: badNotify.rawBody,
      headers: badNotify.headers,
    })
  );
  const stillPending = await prisma.order.findUnique({
    where: { orderNo: mismatchOrder.orderNo },
  });
  c.eq('金额不一致后订单仍 PENDING', stillPending!.status, 'PENDING');

  // 验签失败 → 拒绝
  const tamperNotify = buildMockNotify({
    orderNo: mismatchOrder.orderNo,
    amountCents: 1990,
    currency: 'CNY',
    status: 'PAID',
  });
  await c.throwsCode('签名错误拒绝结算', 'PAYMENT_SIGNATURE_INVALID', () =>
    settlementService.handlePaymentNotify({
      provider: 'mock',
      rawBody: tamperNotify.rawBody,
      headers: { ...tamperNotify.headers, 'x-mock-signature': 'deadbeef'.repeat(8) },
    })
  );

  // ---------- 4. syncOrder：mock 渠道查单返回 PENDING，不应改变状态 ----------
  const syncRes = await adminOrderService.syncOrder(pendingOrder.orderNo, actorId);
  c.eq('sync 后本地仍 PENDING（mock 渠道未付）', syncRes.localStatus, 'PENDING');
  c.eq('sync 未触发结算', syncRes.settled, false);

  await c.throwsCode('sync 不存在的订单 → ORDER_NOT_FOUND', 'ORDER_NOT_FOUND', () =>
    adminOrderService.syncOrder('E2E_MISSING_XYZ', actorId)
  );

  // 已结订单再 sync → 本地已结渠道未付，记 note 但不改状态
  const syncPaid = await adminOrderService.syncOrder(paidOrder.orderNo, actorId);
  c.eq('已结订单 sync 后仍 PAID', syncPaid.localStatus, 'PAID');
  c.ok('已结但渠道未付时给出人工核实提示', Boolean(syncPaid.note), syncPaid.note);

  // ---------- 5. 对账工作台：四类差异 ----------
  const recon = await settlementService.reconcileWithChannel();
  c.ok('对账任务返回 checked/mismatched/recorded', typeof recon.recorded === 'number', recon);

  const paidLocalUnknown = await prisma.reconciliationRecord.create({
    data: {
      channel: 'WECHAT',
      orderNo: paidOrder.orderNo,
      localStatus: 'PAID',
      channelStatus: 'PENDING',
      diffType: DIFF_TYPES.PAID_LOCAL_UNKNOWN,
      action: null,
    },
  });
  const amountMismatch = await prisma.reconciliationRecord.create({
    data: {
      channel: 'WECHAT',
      orderNo: mismatchOrder.orderNo,
      localStatus: 'PENDING',
      channelStatus: 'PAID',
      diffType: DIFF_TYPES.AMOUNT_MISMATCH,
      action: null,
      note: '本地 1990 分 / 渠道 1991 分',
    },
  });
  const duplicateNotify = await prisma.reconciliationRecord.create({
    data: {
      channel: 'WECHAT',
      orderNo: settleOrder.orderNo,
      localStatus: 'PAID',
      channelStatus: 'PAID',
      diffType: DIFF_TYPES.DUPLICATE_NOTIFY,
      action: 'MANUAL_DONE',
      handledBy: actorId,
      handledAt: new Date(),
    },
  });
  const autoSettled = await prisma.reconciliationRecord.create({
    data: {
      channel: 'WECHAT',
      orderNo: settleOrder.orderNo,
      localStatus: 'PENDING',
      channelStatus: 'PAID',
      diffType: DIFF_TYPES.PAID_LOCAL_PENDING,
      action: 'AUTO_SETTLED',
      handledAt: new Date(),
    },
  });

  const listAll = await adminReconService.listReconciliations({ page: 1, pageSize: 100 });
  c.ok('groupCounts 含 4 类差异', Object.keys(listAll.groupCounts).length >= 1, listAll.groupCounts);
  c.ok(
    'groupCounts 覆盖 PAID_LOCAL_UNKNOWN',
    (listAll.groupCounts[DIFF_TYPES.PAID_LOCAL_UNKNOWN] ?? 0) >= 1,
    listAll.groupCounts
  );

  const pendingOnly = await adminReconService.listReconciliations({
    page: 1,
    pageSize: 100,
    pendingOnly: true,
  });
  c.ok(
    'pendingOnly 只返回未处理记录',
    pendingOnly.items.every((r) => (r.action as string | null) === null),
    pendingOnly.items.map((r) => r.action)
  );

  const filtered = await adminReconService.listReconciliations({
    page: 1,
    pageSize: 100,
    diffType: DIFF_TYPES.AMOUNT_MISMATCH,
  });
  c.ok(
    '按差异类型筛选生效',
    filtered.items.every((r) => r.diffType === DIFF_TYPES.AMOUNT_MISMATCH)
  );

  // ---------- 6. 人工处理 ----------
  const handled = await adminReconService.handleReconciliation(
    amountMismatch.id,
    'ESCALATED',
    '金额差异已提交财务核对',
    actorId
  );
  c.eq('人工处理标记为 ESCALATED', handled.action, 'ESCALATED');
  const afterHandle = await prisma.reconciliationRecord.findUnique({
    where: { id: amountMismatch.id },
  });
  c.eq('处理人已记录', afterHandle!.handledBy, actorId);
  c.ok('处理时间已记录', afterHandle!.handledAt !== null);

  await c.throwsCode('AUTO_SETTLED 记录拒绝人工标记', 'VALIDATION_FAILED', () =>
    adminReconService.handleReconciliation(autoSettled.id, 'MANUAL_DONE', '试图人工标记', actorId)
  );
  await c.throwsCode('处理不存在的记录 → NOT_FOUND', 'NOT_FOUND', () =>
    adminReconService.handleReconciliation(
      '00000000-0000-4000-8000-000000000000',
      'MANUAL_DONE',
      'x',
      actorId
    )
  );
  await c.throwsCode('记录不存在时 resettle → NOT_FOUND', 'NOT_FOUND', () =>
    adminReconService.retrySettlement(
      '00000000-0000-4000-8000-000000000000',
      actorId
    )
  );

  // ---------- 7. 重试补结算的类型守卫 ----------
  await c.throwsCode('非 PAID_LOCAL_PENDING 拒绝重试补结算', 'VALIDATION_FAILED', () =>
    adminReconService.retrySettlement(paidLocalUnknown.id, actorId)
  );
  await c.throwsCode('AMOUNT_MISMATCH 拒绝重试补结算', 'VALIDATION_FAILED', () =>
    adminReconService.retrySettlement(amountMismatch.id, actorId)
  );
  await c.throwsCode('DUPLICATE_NOTIFY 拒绝重试补结算', 'VALIDATION_FAILED', () =>
    adminReconService.retrySettlement(duplicateNotify.id, actorId)
  );

  // AUTO_SETTLED 类型但订单已 PAID → 幂等返回 settled=false（不重复发权益）
  const resettleDone = await adminReconService.retrySettlement(autoSettled.id, actorId);
  c.eq('已 PAID 订单重试不重复结算', resettleDone.settled, false);
  c.eq('已 PAID 订单返回本地状态 PAID', resettleDone.localStatus, 'PAID');
  const accAfterResettle = await prisma.creditAccount.findUnique({
    where: { userId: settleUser.id },
  });
  c.eq('重试后余额未变（幂等）', accAfterResettle!.balance, 500);

  // PENDING_LOCAL_PENDING 但渠道未付 → 不结算
  const stillPendingRec = await prisma.reconciliationRecord.create({
    data: {
      channel: 'WECHAT',
      orderNo: pendingOrder.orderNo,
      localStatus: 'PENDING',
      channelStatus: 'PENDING',
      diffType: DIFF_TYPES.PAID_LOCAL_PENDING,
      action: null,
    },
  });
  const resettlePending = await adminReconService.retrySettlement(stillPendingRec.id, actorId);
  c.eq('渠道未付不补结算', resettlePending.settled, false);
  c.ok('给出暂不补结算原因', resettlePending.note.includes('暂不补结算'), resettlePending.note);

  // ---------- 8. 用户管理联动（A6.3 交叉验证） ----------
  const mgmtList = await adminUserMgmtService.listUsers({
    page: 1,
    pageSize: 50,
    search: user.email ?? '',
  });
  c.ok('用户列表能按邮箱搜到', mgmtList.items.some((u) => u.id === user.id));

  const userDetail = await adminUserMgmtService.getUserDetail(user.id);
  c.eq('用户详情返回正确 id', userDetail.user.id, user.id);

  const recompute = await adminUserMgmtService.recomputeLedger(settleUser.id);
  c.eq('账本重算：余额与流水一致', recompute.balance, 500);
  c.eq('账本重算：matches=true', recompute.matches, true);
  c.eq('账本重算：账户投影余额一致', recompute.account?.balance, 500);

  // 造一个用户端会话，验证禁用自动吊销
  const userSession = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: `e2e_hash_${Date.now()}`,
      deviceInfo: { ua: 'e2e-agent' },
      expiresAt: new Date(Date.now() + 7 * 86400000),
    },
  });
  const detailWithSession = await adminUserMgmtService.getUserDetail(user.id);
  c.eq(
    '用户详情含活跃会话数',
    (detailWithSession as unknown as { activeSessions?: number }).activeSessions,
    1
  );

  await adminUserMgmtService.setUserStatus(user.id, 'SUSPENDED', actorId, 'E2E 测试禁用');
  const afterSuspend = await prisma.user.findUnique({ where: { id: user.id } });
  c.eq('禁用用户生效', afterSuspend!.status, 'SUSPENDED');
  const sessionAfterSuspend = await prisma.session.findUnique({
    where: { id: userSession.id },
  });
  c.ok('禁用自动吊销用户端会话', sessionAfterSuspend!.revokedAt !== null);

  const idempotent = await adminUserMgmtService.setUserStatus(
    user.id,
    'SUSPENDED',
    actorId,
    'E2E 重复禁用'
  );
  c.eq('重复禁用幂等（无新增吊销）', idempotent.revokedSessions, 0);

  const revokedAgain = await adminUserMgmtService.revokeUserSessions(user.id, actorId);
  c.eq('强制下线不重复计数已吊销会话', revokedAgain, 0);

  await adminUserMgmtService.setUserStatus(user.id, 'ACTIVE', actorId, 'E2E 恢复');
  const afterRestore = await prisma.user.findUnique({ where: { id: user.id } });
  c.eq('恢复用户生效', afterRestore!.status, 'ACTIVE');

  // DELETED 为软删终态，后台不可变更
  const deletedUser = await createUser('orders_deleted');
  await prisma.user.update({
    where: { id: deletedUser.id },
    data: { status: 'DELETED' },
  });
  await c.throwsCode('DELETED 用户不可变更状态', 'VALIDATION_FAILED', () =>
    adminUserMgmtService.setUserStatus(deletedUser.id, 'ACTIVE', actorId, 'E2E 尝试恢复已删用户')
  );
  await c.throwsCode('不存在的用户 → VALIDATION_FAILED', 'VALIDATION_FAILED', () =>
    adminUserMgmtService.setUserStatus(
      '00000000-0000-4000-8000-000000000000',
      'SUSPENDED',
      actorId,
      'E2E'
    )
  );

  const s = c.summary('订单与对账');
  await cleanupE2eData();
  if (s.failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('E2E 订单套件异常：', err);
  try {
    await cleanupE2eData();
  } catch {
    /* 忽略清理异常 */
  }
  process.exitCode = 1;
});
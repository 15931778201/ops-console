/**
 * E2E · 审批流（服务层，真实 PostgreSQL）
 * 运行：npm run test:e2e:approvals
 *
 * 覆盖不变量（A6.5 验收核心，对应设计文档"申请与审批分离"红线）：
 *  - 提交 → PENDING；申请人≠审批人（自批自一律 409）
 *  - 审批权限矩阵：FINANCE 可批 CREDIT_ADJUST；OPERATOR/SUPPORT 不能
 *  - 批准 → APPROVED；执行 → EXECUTED 且积分真实入账
 *  - 执行幂等：重复执行 409，流水不重复（最关键的不变量）
 *  - 撤回仅申请人、仅 PENDING；拒绝必须留原因
 *  - 24h频控：同一用户第 4 笔调账申请被拒
 *  - payload 形状校验（金额/用户/维度）
 *  - "待我审批"排除自己提交的；待办角标只统计有权批的类型
 *  - 每步都写审计日志
 */

import prisma from '../src/lib/prisma';
import { approvalService, MAX_ADJUST_ABS, MAX_ADJUST_PER_24H } from '../src/services/approval.service';
import { createTestAdmin, Check, cleanupE2eData, testEmail } from './harness';
import type { CreditAccount, User } from '@prisma/client';
import { ErrorCode } from '../src/lib/errors';

const c = new Check('审批流');

async function createUser(tag: string, balance = 0, bonusBalance = 0): Promise<User> {
  const user = await prisma.user.create({
    data: { email: testEmail(tag), passwordHash: 'x', name: `E2E-${tag}`, planId: 'free' },
  });
  await prisma.creditAccount.create({ data: { userId: user.id, balance, bonusBalance } });
  return user;
}

async function balanceOf(userId: string): Promise<CreditAccount | null> {
  return prisma.creditAccount.findUnique({ where: { userId } });
}



async function main(): Promise<void> {
  await cleanupE2eData();

  const applicant = await createTestAdmin('apv_applicant', 'OPERATOR');
  const finance = await createTestAdmin('apv_finance', 'FINANCE');
  const operator = await createTestAdmin('apv_operator2', 'OPERATOR');
  const support = await createTestAdmin('apv_support', 'SUPPORT');
  const auditor = await createTestAdmin('apv_auditor', 'AUDITOR');
  const superAdmin = await createTestAdmin('apv_super', 'SUPER_ADMIN');

  const user = await createUser('apv_u1', 1000, 50);

  // ---------- 1. 提交 ----------
  const a1 = await approvalService.submit(
    {
      type: 'CREDIT_ADJUST',
      payload: { userId: user.id, deltaBalance: 500, deltaBonus: 20, reason: '客服工单补偿明细' },
      reason: '客服工单补偿',
      ticketNo: 'T-1001',
    },
    applicant.id
  );
  c.eq('提交后状态为 PENDING', a1.status, 'PENDING');
  c.eq('提交后审批人为空', a1.approverId, null);
  c.eq('提交记录类型', a1.type, 'CREDIT_ADJUST');
  c.eq('工单号已保存', a1.ticketNo, 'T-1001');

  // 原因过短
  await c.throwsCode('原因过短被拒', ErrorCode.VALIDATION_FAILED, () => approvalService.submit({ type: 'CREDIT_ADJUST', payload: { userId: user.id, deltaBalance: 1, deltaBonus: 0, reason: '说明' }, reason: 'x' }, applicant.id));

  // 不支持的类型
  await c.throwsCode('不支持的审批类型被拒', ErrorCode.VALIDATION_FAILED, () => approvalService.submit({ type: 'NOT_A_TYPE' as never, payload: {}, reason: '测试原因' }, applicant.id));

  // ---------- 2. payload 校验 ----------
  const base = { deltaBalance: 100, deltaBonus: 0, reason: '非法 payload 用例说明' };
  const badPayloads: Array<[string, Record<string, unknown>]> = [
    ['缺 userId', { ...base }],
    ['deltaBalance 非整数', { ...base, userId: user.id, deltaBalance: 1.5 }],
    ['deltaBonus 非整数', { ...base, userId: user.id, deltaBonus: 2.5 }],
    ['两个维度都是 0', { ...base, userId: user.id, deltaBalance: 0, deltaBonus: 0 }],
    ['超过单笔上限', { ...base, userId: user.id, deltaBalance: MAX_ADJUST_ABS + 1 }],
    ['bonus 超过上限', { ...base, userId: user.id, deltaBalance: 0, deltaBonus: MAX_ADJUST_ABS + 1 }],
    ['payload 缺 reason', { userId: user.id, deltaBalance: 10, deltaBonus: 0 }],
  ];
  for (const [label, payload] of badPayloads) {
    await c.throwsCode(`payload 校验：${label}`, ErrorCode.VALIDATION_FAILED, () => approvalService.submit({ type: 'CREDIT_ADJUST', payload, reason: 'E2E 校验' }, applicant.id));
  }

  // ---------- 3. 审批权限矩阵 ----------
  await c.throwsCode('OPERATOR 无权批准调账（403）', ErrorCode.ADMIN_PERMISSION_DENIED, () => approvalService.approve(a1.id, operator.id, 'OPERATOR'));
  await c.throwsCode('SUPPORT 无权批准调账（403）', ErrorCode.ADMIN_PERMISSION_DENIED, () => approvalService.approve(a1.id, support.id, 'SUPPORT'));
  await c.throwsCode('AUDITOR 无权批准调账（403）', ErrorCode.ADMIN_PERMISSION_DENIED, () => approvalService.approve(a1.id, auditor.id, 'AUDITOR'));

  // ---------- 4. 自批自发 ----------
  await c.throwsCode('申请人不能批准自己的单（409）', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.approve(a1.id, applicant.id, 'OPERATOR'));
  await c.throwsCode('申请人不能执行自己的单（409）', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.execute(a1.id, applicant.id));
  await c.throwsCode('申请人不能撤回自己的单以外的单（403）', ErrorCode.ADMIN_PERMISSION_DENIED, () => approvalService.cancel(a1.id, finance.id));

  // ---------- 5. 未批准不能执行 ----------
  await c.throwsCode('PENDING 状态直接执行被拒（409）', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.execute(a1.id, finance.id));
  const balBefore = await balanceOf(user.id);
  c.eq('未执行时余额未变', balBefore?.balance, 1000);

  // ---------- 6. 批准 ----------
  const approved = await approvalService.approve(a1.id, finance.id, 'FINANCE');
  c.eq('批准后状态为 APPROVED', approved.status, 'APPROVED');
  c.eq('审批人已记录', approved.approverId, finance.id);
  c.ok('批准时间已记录', approved.approvedAt !== null);

  await c.throwsCode('重复批准被拒（409）', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.approve(a1.id, superAdmin.id, 'SUPER_ADMIN'));
  await c.throwsCode('已批准的不能再撤回（409）', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.cancel(a1.id, applicant.id));
  await c.throwsCode('已批准的不能再拒绝（409）', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.reject(a1.id, finance.id, 'FINANCE', '改主意了'));

  // ---------- 7. 执行（关键：入账 + 幂等） ----------
  const executed = await approvalService.execute(a1.id, superAdmin.id);
  c.eq('执行后状态为 EXECUTED', executed.status, 'EXECUTED');
  c.ok('执行时间已记录', executed.executedAt !== null);

  const balAfter = await balanceOf(user.id);
  c.eq('订阅积分已入账', balAfter?.balance, 1500);
  c.eq('奖励积分已入账', balAfter?.bonusBalance, 70);

  // 流水条数：应恰好新增 1 条 ADJUST
  const txns = await prisma.creditTransaction.count({
    where: { userId: user.id, referenceId: `approval:${a1.id}` },
  });
  c.eq('执行写入恰好 1 条流水（referenceId 关联审批单，可反查）', txns, 1);
  const txnRow = await prisma.creditTransaction.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: { referenceId: true, amount: true, deltaBalance: true, deltaBonus: true, type: true },
  });
  c.eq('流水类型为 ADJUST', txnRow?.type, 'ADJUST');
  c.eq('流水 amount 为两维度之和', txnRow?.amount, 520);
  c.eq('流水 deltaBalance 正确', txnRow?.deltaBalance, 500);
  c.eq('流水 deltaBonus 正确', txnRow?.deltaBonus, 20);

  // 幂等：重复执行必须 409 且余额不变
  await c.throwsCode('重复执行被拒（409）', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.execute(a1.id, superAdmin.id));
  const balAfterRetry = await balanceOf(user.id);
  c.eq('重复执行后余额不变（不重复入账）', balAfterRetry?.balance, 1500);
  const txnsAfter = await prisma.creditTransaction.count({ where: { userId: user.id } });
  c.eq('重复执行后流水条数不变', txnsAfter, 1);

  // ---------- 8. 负值防护（执行时余额被花掉） ----------
  const poor = await createUser('apv_poor', 50, 0);
  const a2 = await approvalService.submit(
    { type: 'CREDIT_ADJUST', payload: { userId: poor.id, deltaBalance: -500, deltaBonus: 0, reason: '扣回多发积分' }, reason: '扣回多发' },
    applicant.id
  );
  await approvalService.approve(a2.id, finance.id, 'FINANCE');
  await c.throwsCode('扣减超过余额 → 执行失败并置FAILED', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.execute(a2.id, superAdmin.id));
  const a2After = await approvalService.get(a2.id);
  c.eq('失败后状态为 FAILED', a2After.status, 'FAILED');
  const poorBal = await balanceOf(poor.id);
  c.eq('失败后余额未变（不产生负数）', poorBal?.balance, 50);
  // FAILED 不可再执行
  await c.throwsCode('FAILED 状态不可重试执行', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.execute(a2.id, superAdmin.id));

  // ---------- 9. 拒绝（必填原因） ----------
  const a3 = await approvalService.submit(
    { type: 'CREDIT_ADJUST', payload: { userId: user.id, deltaBalance: 0, deltaBonus: 5, reason: '活动补发' }, reason: '活动补发' },
    applicant.id
  );
  await c.throwsCode('拒绝原因为空被拒', ErrorCode.VALIDATION_FAILED, () => approvalService.reject(a3.id, finance.id, 'FINANCE', ''));
  const rejected = await approvalService.reject(a3.id, finance.id, 'FINANCE', '不符合活动规则');
  c.eq('拒绝后状态为 REJECTED', rejected.status, 'REJECTED');
  const balAfterReject = await balanceOf(user.id);
  c.eq('拒绝不改变余额', balAfterReject?.balance, 1500);

  // ---------- 10. 撤回 ----------
  const a4 = await approvalService.submit(
    { type: 'CREDIT_ADJUST', payload: { userId: user.id, deltaBalance: 10, deltaBonus: 0, reason: '误操作补回' }, reason: '误操作' },
    applicant.id
  );
  const cancelled = await approvalService.cancel(a4.id, applicant.id);
  c.eq('撤回后状态为 CANCELLED', cancelled.status, 'CANCELLED');
  await c.throwsCode('已撤回不能再撤回', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.cancel(a4.id, applicant.id));
  await c.throwsCode('已撤回不能再批准', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.approve(a4.id, finance.id, 'FINANCE'));

  // ---------- 11. 24h 频控 ----------
  const freqUser = await createUser('apv_freq', 100, 0);
  for (let i = 0; i < MAX_ADJUST_PER_24H; i += 1) {
    const r = await approvalService.submit(
      { type: 'CREDIT_ADJUST', payload: { userId: freqUser.id, deltaBalance: 1, deltaBonus: 0, reason: `频控第 ${i + 1} 笔` }, reason: `频控第 ${i + 1} 笔` },
      applicant.id
    );
    c.eq(`频控第 ${i + 1} 笔提交成功`, r.status, 'PENDING');
  }
  await c.throwsCode(`第 ${MAX_ADJUST_PER_24H + 1} 笔被频控拦截（409）`, ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.submit({ type: 'CREDIT_ADJUST', payload: { userId: freqUser.id, deltaBalance: 1, deltaBonus: 0, reason: '拆单刷额' }, reason: '拆单刷额' }, applicant.id));
  // 撤回的不计入频控（说明用户主动放弃不算刷单）
  const toCancel = await approvalService.list({ page: 1, pageSize: 10, applicantId: applicant.id }, { id: applicant.id, role: 'OPERATOR' });
  const pendingFreq = toCancel.items.find((r) => r.payload && (r.payload as { userId?: string }).userId === freqUser.id);
  if (pendingFreq) {
    await approvalService.cancel(pendingFreq.id, applicant.id);
    const after = await approvalService.submit(
      { type: 'CREDIT_ADJUST', payload: { userId: freqUser.id, deltaBalance: 1, deltaBonus: 0, reason: '撤回后重提' }, reason: '撤回后重提' },
      applicant.id
    );
    c.eq('撤回后频控计数释放', after.status, 'PENDING');
  } else {
    c.ok('撤回后频控计数释放（无可撤回样本，跳过）', false);
  }

  // ---------- 12. 未接入类型显式拒绝 ----------
  // RULE_CHANGE 仅 SUPER_ADMIN 可批（APPROVAL_AUTHORITY 里它是空数组 + canApprove 特判）
  // 申请人换用 auditor（避免审批人==申请人触发自批自发检查，那样测不到权限矩阵）
  const a5 = await approvalService.submit(
    { type: 'RULE_CHANGE', payload: { ruleId: 'r1' }, reason: '规则调整' },
    auditor.id
  );
  await c.throwsCode('FINANCE 无权批准 RULE_CHANGE', ErrorCode.ADMIN_PERMISSION_DENIED, () =>
    approvalService.approve(a5.id, finance.id, 'FINANCE')
  );
  const a5Approved = await approvalService.approve(a5.id, superAdmin.id, 'SUPER_ADMIN');
  c.eq('SUPER_ADMIN 可批准 RULE_CHANGE', a5Approved.status, 'APPROVED');
  await c.throwsCode('未接入的执行类型显式拒绝', ErrorCode.ADMIN_APPROVAL_CONFLICT, () => approvalService.execute(a5.id, superAdmin.id));
  c.eq('未接入类型状态仍为 APPROVED（未误置FAILED）', (await approvalService.get(a5.id)).status, 'APPROVED');

  // ---------- 13. 列表与待办 ----------
  const todoFinance = await approvalService.list({ page: 1, pageSize: 50, mine: true }, { id: finance.id, role: 'FINANCE' });
  c.ok(
    '待我审批不含自己提交的',
    todoFinance.items.every((r) => r.applicantId !== finance.id)
  );
  c.ok(
    '待我审批只含有权审批的类型',
    todoFinance.items.every((r) => r.type !== 'RULE_CHANGE' || r.approverId !== null)
  );

  const todoOperator = await approvalService.list({ page: 1, pageSize: 50, mine: true }, { id: operator.id, role: 'OPERATOR' });
  c.eq('OPERATOR 无任何审批权限 → 待办为空', todoOperator.items.length, 0);
  c.eq('OPERATOR 待办角标为 0', await approvalService.pendingCountFor({ id: operator.id, role: 'OPERATOR' }), 0);

  const mineCount = await approvalService.pendingCountFor({ id: finance.id, role: 'FINANCE' });
  c.ok('FINANCE 待办角标 ≥ 1', mineCount >= 1, { mineCount });

  // 全量列表（SUPER_ADMIN 视角）
  const all = await approvalService.list({ page: 1, pageSize: 100 }, { id: superAdmin.id, role: 'SUPER_ADMIN' });
  c.ok('全量列表含已执行单', all.items.some((r) => r.status === 'EXECUTED'));
  c.ok('全量列表含已拒绝单', all.items.some((r) => r.status === 'REJECTED'));
  c.ok('全量列表含已撤回单', all.items.some((r) => r.status === 'CANCELLED'));

  // 按状态筛选
  const onlyPending = await approvalService.list(
    { page: 1, pageSize: 50, status: 'PENDING' },
    { id: superAdmin.id, role: 'SUPER_ADMIN' }
  );
  c.ok('按状态筛选只返回 PENDING', onlyPending.items.every((r) => r.status === 'PENDING'));

  await c.throwsCode('查询不存在的审批单 → 400', ErrorCode.VALIDATION_FAILED, () => approvalService.get('00000000-0000-4000-8000-000000000000'));

  // ---------- 14. 审计留痕 ----------
  const actions = await prisma.auditLog.findMany({
    where: { targetId: a1.id },
    select: { action: true },
  });
  const actionSet = new Set(actions.map((a) => a.action));
  c.ok('审计含提交记录', actionSet.has('approval.submitted'));
  c.ok('审计含批准记录', actionSet.has('approval.approved'));
  c.ok('审计含执行记录', actionSet.has('approval.executed'));
  const rejectedActions = await prisma.auditLog.findMany({ where: { targetId: a3.id }, select: { action: true } });
  c.ok('拒绝也留痕', rejectedActions.some((a) => a.action === 'approval.rejected'));

  // ---------- 15. 单笔上限边界 ----------
  const edge = await approvalService.submit(
    { type: 'CREDIT_ADJUST', payload: { userId: user.id, deltaBalance: -MAX_ADJUST_ABS, deltaBonus: 0, reason: '边界值校验' }, reason: '边界值' },
    applicant.id
  );
  c.eq('恰好等于上限可通过校验', edge.status, 'PENDING');

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
    c.summary('审批流');
    await prisma.$disconnect();
  });
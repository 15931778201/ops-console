/**
 * Mock 扩展：审批 / 积分账本 / 套餐与规则 / 系统开关 / 审计 / 监控告警。
 * 由 server.ts 的 mockRequest 在核心模块之后调用；未命中返回 NOT_HANDLED。
 */

import { ApiError } from '../lib/api-client';

export const NOT_HANDLED = Symbol('not-handled');

type Query = Record<string, string | number | boolean | undefined | null>;
type Obj = Record<string, unknown>;

const ago = (min: number): string => new Date(Date.now() - min * 60000).toISOString();
const delay = <T>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 120));
const fail = (status: number, code: string, msg: string): never => {
  throw new ApiError(status, code, msg);
};
const page = <T>(all: T[], q: Query): { items: T[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } } => {
  const p = Number(q.page) || 1;
  const size = Number(q.pageSize) || 20;
  return {
    items: all.slice((p - 1) * size, p * size),
    pagination: { page: p, pageSize: size, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / size)) },
  };
};

// ---------- 审批 ----------

interface MApproval {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  reason: string;
  ticketNo: string | null;
  applicantId: string;
  approverId: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  result: Obj | null;
  createdAt: string;
}
const approvals: MApproval[] = [
  ['adm_2', 'PENDING', 500, 0, '用户重复支付补偿', 'TK-2610-0011'],
  ['adm_3', 'PENDING', -120, 0, '误发奖励回收', null],
  ['adm_2', 'EXECUTED', 300, 50, '活动补发积分', 'TK-2610-0007'],
  ['adm_3', 'REJECTED', 100000, 0, '大额补偿（证据不足）', null],
  ['adm_1', 'PENDING', 80, 0, '客服补偿', 'TK-2610-0014'],
  ['adm_2', 'FAILED', -900, 0, '扣回异常积分', 'TK-2610-0009'],
  ['adm_3', 'CANCELLED', 50, 0, '申请已撤回', null],
  ['adm_2', 'EXECUTED', 1000, 0, '订单异常补发', 'TK-2610-0003'],
].map(([applicantId, status, db, dbo, reason, ticketNo], i) => ({
  id: `apv_${i + 1}`,
  type: 'CREDIT_ADJUST',
  status: status as string,
  payload: { userId: `u_${1000 + i * 2}`, deltaBalance: db, deltaBonus: dbo, reason },
  reason: reason as string,
  ticketNo: ticketNo as string | null,
  applicantId: applicantId as string,
  approverId: ['EXECUTED', 'REJECTED', 'FAILED'].includes(status as string) ? 'adm_4' : null,
  approvedAt: ['EXECUTED', 'FAILED'].includes(status as string) ? ago(60 * i) : null,
  executedAt: status === 'EXECUTED' ? ago(60 * i) : null,
  result: status === 'EXECUTED' ? { ok: true } : status === 'FAILED' ? { error: '余额不足，无法扣减' } : null,
  createdAt: ago(60 * (i * 7 + 3)),
}));

// ---------- 开关 ----------

const flagMeta = [
  { key: 'paymentAcceptingOrders', flag: 'payment.accepting_orders', label: '支付收单', description: '关闭后新订单创建被拒（停收），已付款订单不受影响', defaultValue: true },
  { key: 'registrationOpen', flag: 'auth.registration_open', label: '开放注册', description: '关闭后新用户无法注册', defaultValue: true },
  { key: 'paymentMockChannel', flag: 'payment.mock_channel', label: 'Mock 支付通道', description: '仅开发/预生产启用的模拟支付通道', defaultValue: false },
];
const flagState: Record<string, { value: boolean; updatedAt: string | null; updatedBy: string | null }> = {
  paymentAcceptingOrders: { value: true, updatedAt: null, updatedBy: null },
  registrationOpen: { value: true, updatedAt: ago(60 * 48), updatedBy: 'ops' },
  paymentMockChannel: { value: false, updatedAt: null, updatedBy: null },
};
const flagItem = (m: (typeof flagMeta)[number]): Obj => {
  const st = flagState[m.key]!;
  return { ...m, value: st.value, isDefault: st.value === m.defaultValue, updatedAt: st.updatedAt, updatedBy: st.updatedBy, hasOverride: st.updatedAt !== null };
};

// ---------- 审计 ----------

const ACTIONS: Array<[string, string, string | null]> = [
  ['admin.login', '管理员登录', 'admin'],
  ['user.suspend', '禁用用户', 'user'],
  ['user.activate', '恢复用户', 'user'],
  ['plan.update', '修改套餐', 'plan'],
  ['approval.approve', '批准审批单', 'approval'],
  ['flag.set', '切换系统开关', 'flag'],
  ['reconcile.handle', '处理对账差异', 'reconciliation'],
  ['audit.exported', '导出审计日志', null],
];
interface MAudit {
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  actionLabel: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: unknown;
  requestId: string | null;
  createdAt: string;
}
const audits: MAudit[] = Array.from({ length: 42 }, (_, i) => {
  const [action, label, target] = ACTIONS[i % ACTIONS.length]!;
  const adm = ['adm_1', 'adm_2', 'adm_3'][i % 3]!;
  return {
    id: `aud_${i + 1}`,
    actorType: i % 11 === 10 ? 'SYSTEM' : 'ADMIN',
    actorId: i % 11 === 10 ? null : adm,
    actorName: i % 11 === 10 ? null : { adm_1: '运营主管', adm_2: '张芸', adm_3: '李客服' }[adm]!,
    action,
    actionLabel: label,
    targetType: target,
    targetId: target ? `${target}_${100 + i}` : null,
    reason: i % 3 === 0 ? '运营日常操作' : null,
    metadata: { before: { value: i }, after: { value: i + 1 }, ip: '10.0.0.' + (i % 50) },
    requestId: `req-${(1000 + i * 31).toString(16)}`,
    createdAt: ago(25 * i + 3),
  };
});

// ---------- 账本 ----------

const TXN_TYPES = [
  ['CONSUME', '工具消耗'],
  ['GRANT', '订阅发放'],
  ['RESET', '周期重置'],
  ['REFUND', '退款'],
  ['ADJUST', '人工调账'],
  ['INVITE_GRANT', '邀请奖励'],
  ['BONUS', '奖励积分'],
] as const;
const REASONS = [
  ['BALANCE_MISMATCH', '订阅积分不一致'],
  ['BONUS_MISMATCH', '奖励积分不一致'],
  ['BOTH_MISMATCH', '两项均不一致'],
  ['NEGATIVE_BALANCE', '余额为负'],
  ['NO_TRANSACTION_BALANCE', '无流水却有余额'],
] as const;
interface MTxn {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  type: string;
  typeLabel: string;
  status: string;
  amount: number;
  deltaBalance: number;
  deltaBonus: number;
  balanceAfterBalance: number;
  balanceAfterBonus: number;
  toolSlug: string | null;
  fileCount: number | null;
  referenceId: string | null;
  billingTxnId: string | null;
  linkedTxnId: string | null;
  description: string | null;
  createdAt: string;
}
const txns: MTxn[] = Array.from({ length: 64 }, (_, i) => {
  const [type, typeLabel] = TXN_TYPES[i % TXN_TYPES.length]!;
  const delta = type === 'CONSUME' ? -(2 + (i % 8)) : 100 + (i % 5) * 50;
  const uid = `u_${1000 + (i % 12)}`;
  return {
    id: `tx_${i + 1}`,
    userId: uid,
    userEmail: `user${(i % 12) + 1}@example.com`,
    userName: null,
    type,
    typeLabel,
    status: i % 17 === 16 ? 'ROLLED_BACK' : 'SETTLED',
    amount: delta,
    deltaBalance: type === 'BONUS' || type === 'INVITE_GRANT' ? 0 : delta,
    deltaBonus: type === 'BONUS' || type === 'INVITE_GRANT' ? delta : 0,
    balanceAfterBalance: 300 + (i % 9) * 20,
    balanceAfterBonus: 20,
    toolSlug: type === 'CONSUME' ? ['pdf-merge', 'pdf-compress', 'ocr'][i % 3]! : null,
    fileCount: type === 'CONSUME' ? 1 + (i % 3) : null,
    referenceId: `ref-${5000 + i}`,
    billingTxnId: null,
    linkedTxnId: null,
    description: type === 'CONSUME' ? '工具调用扣费' : '系统发放',
    createdAt: ago(37 * i + 5),
  };
});
const anomalies = [
  { userId: 'u_1003', userEmail: 'user4@example.com', userName: '郭靖', userStatus: 'ACTIVE', planId: 'pro', balance: 240, bonusBalance: 0, expectedBalance: 200, expectedBonus: 0, diffBalance: 40, diffBonus: 0, reason: 'BALANCE_MISMATCH', txnCount: 12, lastTxnAt: ago(400) },
  { userId: 'u_1008', userEmail: 'user9@example.com', userName: '胡斌', userStatus: 'ACTIVE', planId: 'free', balance: -15, bonusBalance: 0, expectedBalance: -15, expectedBonus: 0, diffBalance: 0, diffBonus: 0, reason: 'NEGATIVE_BALANCE', txnCount: 7, lastTxnAt: ago(90) },
  { userId: 'u_1011', userEmail: 'user12@example.com', userName: '高远', userStatus: 'SUSPENDED', planId: 'vip', balance: 500, bonusBalance: 20, expectedBalance: 0, expectedBonus: 0, diffBalance: 500, diffBonus: 20, reason: 'NO_TRANSACTION_BALANCE', txnCount: 0, lastTxnAt: null },
  { userId: 'u_1014', userEmail: 'user15@example.com', userName: '宋佳', userStatus: 'ACTIVE', planId: 'pro', balance: 90, bonusBalance: 30, expectedBalance: 90, expectedBonus: 10, diffBalance: 0, diffBonus: 20, reason: 'BONUS_MISMATCH', txnCount: 9, lastTxnAt: ago(1200) },
];

// ---------- 套餐 / 规则 ----------

const plans = [
  { id: 'free', name: '免费版', monthlyCredits: 100, priceCents: 0, periodMonths: 1, maxFiles: 3, costTierAccess: ['basic'], active: true, holderCount: 1820, updatedAt: ago(60 * 24 * 30), features: {}, priceHistory: null as Obj[] | null },
  { id: 'pro', name: '专业版', monthlyCredits: 1000, priceCents: 1990, periodMonths: 1, maxFiles: 20, costTierAccess: ['basic', 'standard'], active: true, holderCount: 340, updatedAt: ago(60 * 24 * 5), features: {}, priceHistory: [{ priceCents: 1590, monthlyCredits: 800, changedAt: ago(60 * 24 * 60), changedBy: 'adm_1', reason: '季度调价' }] as Obj[] | null },
  { id: 'vip', name: '旗舰版', monthlyCredits: 5000, priceCents: 4990, periodMonths: 1, maxFiles: 100, costTierAccess: ['basic', 'standard', 'premium'], active: true, holderCount: 66, updatedAt: ago(60 * 24 * 12), features: {}, priceHistory: null as Obj[] | null },
];
const rules = ['pdf-merge', 'pdf-split', 'pdf-compress', 'pdf-to-word', 'ocr', 'pdf-sign', 'pdf-watermark', 'pdf-encrypt'].map((slug, i) => ({
  toolSlug: slug,
  creditCost: 1 + (i % 5) * 2,
  minPlan: i > 5 ? 'pro' : 'free',
  maxFilesPerTask: i % 2 ? 10 : 5,
  ruleVersion: `v${1 + (i % 3)}.0.${i}`,
  active: i !== 7,
  updatedAt: ago(60 * 24 * (i + 2)),
  recentUsage: { calls: 120 + i * 37, credits: -(300 + i * 91) },
}));

// ---------- 告警 ----------

const alertRules = [
  ['payment_success_rate', '支付成功率过低', 'P0', 'payment.success_rate', 0.9, 'lt', 300000, true, 3],
  ['stale_pending_orders', '待支付超时订单堆积', 'P1', 'orders.stale_pending', 5, 'gt', 600000, false, 1],
  ['invalid_signature', '回调验签失败', 'P1', 'payment.invalid_signature', 1, 'gte', 300000, false, 0],
  ['db_latency', '数据库延迟过高', 'P0', 'db.latency_ms', 500, 'gt', 60000, false, 0],
  ['ledger_mismatch', '账本不平账户', 'P1', 'ledger.mismatch', 0, 'gt', 0, false, 0],
  ['recon_open', '对账差异未处理', 'P2', 'recon.open', 10, 'gt', 0, false, 2],
].map(([key, name, severity, metric, threshold, compare, windowMs, firing, hitStreak]) => ({
  key, name, severity, metric, threshold, compare, windowMs, firing, hitStreak,
  lastFiredAt: firing ? ago(35) : null as string | null,
  lastResolvedAt: null as string | null,
}));
interface MAlert {
  id: string;
  severity: string;
  title: string;
  ruleKey: string | null;
  metric: string | null;
  value: number | null;
  threshold: number | null;
  hitStreak: number;
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  detail: unknown;
}
const alertEvents: MAlert[] = Array.from({ length: 18 }, (_, i) => {
  const r = alertRules[i % alertRules.length]!;
  const status = ['sent', 'sent', 'failed', 'suppressed', 'manual'][i % 5]!;
  const open = i < 2;
  return {
    id: `alt_${i + 1}`,
    severity: r.severity as string,
    title: r.name as string,
    ruleKey: r.key as string,
    metric: r.metric as string,
    value: i % 2 ? 7 + i : 0.82,
    threshold: r.threshold as number,
    hitStreak: 1 + (i % 4),
    status,
    attempts: status === 'failed' ? 3 : 1,
    lastError: status === 'failed' ? 'webhook timeout' : null,
    sentAt: status === 'sent' ? ago(60 * i + 2) : null,
    resolvedAt: open ? null : ago(60 * i - 20),
    createdAt: ago(60 * i * 3 + 5),
    detail: { window: '5m', sample: i + 3, note: '来自 Mock 数据' },
  };
});

// ---------- 路由 ----------

export async function extraRequest(method: string, seg: string[], query: Query, body: unknown, meId: string): Promise<unknown> {
  const b = (body ?? {}) as Obj;
  const [r0, r1, r2, r3] = seg;
  const key = `${method} /${seg.join('/')}`;

  // approvals
  if (r0 === 'approvals') {
    if (key === 'GET /approvals/mine-count') return delay({ pendingCount: approvals.filter((a) => a.status === 'PENDING' && a.applicantId !== meId).length });
    if (key === 'POST /approvals/preview') {
      const d = Number(b.deltaBalance ?? 0);
      const bd = Number(b.deltaBonus ?? 0);
      return delay({ currentBalance: 200, currentBonus: 20, afterBalance: 200 + d, afterBonus: 20 + bd, wouldGoNegative: 200 + d < 0, requiresSuperAdmin: Math.abs(d) > 10000, recentCount: 1, maxAbs: 10000 });
    }
    if (!r1 && method === 'GET') {
      let list = approvals.filter((a) => (!query.status || a.status === query.status) && (!query.applicantId || a.applicantId === query.applicantId));
      if (query.mine === 'true' || query.mine === true) list = list.filter((a) => a.status === 'PENDING' && a.applicantId !== meId);
      return delay(page(list, query));
    }
    if (!r1 && method === 'POST') {
      const created: MApproval = {
        id: `apv_${approvals.length + 1}`, type: String(b.type), status: 'PENDING', payload: b.payload, reason: String(b.reason),
        ticketNo: (b.ticketNo as string) ?? null, applicantId: meId, approverId: null, approvedAt: null, executedAt: null, result: null, createdAt: new Date().toISOString(),
      };
      approvals.unshift(created);
      return delay(created);
    }
    const a = approvals.find((x) => x.id === r1) ?? fail(404, 'NOT_FOUND', '审批单不存在');
    if (!r2 && method === 'GET') return delay(a);
    if (r2 === 'approve' || r2 === 'execute') {
      if (a.applicantId === meId) fail(409, 'CONFLICT', '申请人不能审批自己的单子');
      a.status = 'EXECUTED';
      a.approverId = meId;
      a.approvedAt = a.executedAt = new Date().toISOString();
      a.result = { ok: true };
      return delay(a);
    }
    if (r2 === 'reject') {
      a.status = 'REJECTED';
      a.approverId = meId;
      return delay(a);
    }
    if (r2 === 'cancel') {
      a.status = 'CANCELLED';
      return delay(a);
    }
  }

  // flags
  if (r0 === 'flags') {
    if (key === 'GET /flags') return delay({ items: flagMeta.map(flagItem) });
    if (key === 'GET /flags/meta') return delay({ items: flagMeta });
    const m = flagMeta.find((x) => x.key === r1);
    if (m && method === 'PATCH') {
      const st = flagState[m.key]!;
      const next = Boolean(b.value);
      const changed = st.value !== next;
      const prev = st.value;
      st.value = next;
      if (changed) {
        st.updatedAt = new Date().toISOString();
        st.updatedBy = 'ops';
      }
      return delay({ flag: m.flag, previousValue: prev, value: next, changed });
    }
    if (m && r2 === 'reset') {
      flagState[m.key] = { value: m.defaultValue, updatedAt: null, updatedBy: null };
      return delay({ flag: m.flag, value: m.defaultValue });
    }
  }

  // audit
  if (r0 === 'audit-logs') {
    if (key === 'GET /audit-logs/meta')
      return delay({ exportMaxRows: 10000, groups: [{ key: 'admin', label: '管理员', actions: ['admin.login'] }, { key: 'user', label: '用户管理', actions: ['user.suspend', 'user.activate'] }] });
    if (key === 'GET /audit-logs') {
      const list = audits.filter(
        (a) =>
          (!query.actorId || a.actorId === query.actorId) &&
          (!query.actionPrefix || a.action.startsWith(String(query.actionPrefix))) &&
          (!query.action || a.action === query.action) &&
          (!query.targetId || a.targetId?.includes(String(query.targetId))) &&
          (!query.requestId || a.requestId?.includes(String(query.requestId))) &&
          (!query.reason || a.reason?.includes(String(query.reason)))
      );
      const p = Number(query.page) || 1;
      const size = Number(query.pageSize) || 20;
      const counts = new Map<string, { actionLabel: string; count: number }>();
      for (const a of list) counts.set(a.action, { actionLabel: a.actionLabel, count: (counts.get(a.action)?.count ?? 0) + 1 });
      return delay({
        items: list.slice((p - 1) * size, p * size),
        pagination: { total: list.length, page: p, pageSize: size },
        byAction: [...counts].map(([action, v]) => ({ action, ...v })).sort((x, y) => y.count - x.count),
      });
    }
    if (method === 'GET' && r1) return delay(audits.find((a) => a.id === r1) ?? fail(404, 'NOT_FOUND', '审计记录不存在'));
  }

  // ledger
  if (r0 === 'ledger') {
    if (key === 'GET /ledger/meta')
      return delay({
        types: TXN_TYPES.map(([value, label]) => ({ value, label })),
        statuses: [{ value: 'PENDING', label: '处理中' }, { value: 'SETTLED', label: '已结算' }, { value: 'ROLLED_BACK', label: '已回滚' }],
        discrepancyReasons: REASONS.map(([value, label]) => ({ value, label })),
      });
    if (key === 'GET /ledger/transactions') {
      const s = String(query.userSearch ?? '').trim();
      const list = txns.filter(
        (t) =>
          (!s || t.userEmail?.includes(s)) &&
          (!query.type || t.type === query.type) &&
          (!query.status || t.status === query.status) &&
          (!query.toolSlug || t.toolSlug?.includes(String(query.toolSlug))) &&
          (!query.reference || t.referenceId?.includes(String(query.reference)))
      );
      const byType = new Map<string, { label: string; count: number; netAmount: number }>();
      for (const t of list) {
        const cur = byType.get(t.type) ?? { label: t.typeLabel, count: 0, netAmount: 0 };
        cur.count++;
        cur.netAmount += t.amount;
        byType.set(t.type, cur);
      }
      return delay({
        ...page(list, query),
        summary: {
          count: list.length,
          netAmount: list.reduce((s2, t) => s2 + t.amount, 0),
          sumDeltaBalance: list.reduce((s2, t) => s2 + t.deltaBalance, 0),
          sumDeltaBonus: list.reduce((s2, t) => s2 + t.deltaBonus, 0),
          byType: [...byType].map(([type, v]) => ({ type, ...v })),
          hasRolledBack: list.some((t) => t.status === 'ROLLED_BACK'),
        },
      });
    }
    if (key === 'GET /ledger/accounts/anomalies') return delay(page(anomalies.filter((a) => !query.reason || a.reason === query.reason), query));
    if (key === 'POST /ledger/accounts/scan') return delay({ checked: 1820, anomalies: anomalies.length, negative: 1, durationMs: 420 });
    if (r1 === 'accounts' && r2 && !r3) {
      const an = anomalies.find((a) => a.userId === r2);
      const recent = txns.filter((t) => t.userId === r2).slice(0, 20);
      return delay({
        user: { id: r2, email: an?.userEmail ?? `${r2}@example.com`, name: an?.userName ?? null, status: an?.userStatus ?? 'ACTIVE', planId: an?.planId ?? 'pro', createdAt: ago(60 * 24 * 90) },
        account: { balance: an?.balance ?? 320, bonusBalance: an?.bonusBalance ?? 20, monthlyQuota: 1000, periodStart: ago(60 * 24 * 10), periodEnd: ago(-60 * 24 * 20), version: 14, updatedAt: ago(30) },
        recompute: { balance: an?.expectedBalance ?? 320, bonusBalance: an?.expectedBonus ?? 20, matches: !an },
        recentTransactions: recent,
      });
    }
    if (r3 === 'verify') return delay({ userId: r2, balance: 0, bonusBalance: 0, expectedBalance: 0, expectedBonus: 0, diffBalance: 0, diffBonus: 0, matches: true, checkedAt: new Date().toISOString() });
  }

  // catalog
  if (r0 === 'catalog') {
    if (key === 'GET /catalog/plans') return delay({ items: plans.map(({ features: _f, priceHistory: _h, ...p }) => p) });
    if (r1 === 'plans' && r2) {
      const p = plans.find((x) => x.id === r2) ?? fail(404, 'NOT_FOUND', '套餐不存在');
      if (!r3 && method === 'GET') return delay(p);
      if (r3 === 'impact') {
        const np = Number(query.newPriceCents);
        return delay({ planId: p.id, planName: p.name, currentPriceCents: p.priceCents, newPriceCents: np, holderCount: p.holderCount, monthlyRevenueDeltaCents: (np - p.priceCents) * p.holderCount, pendingOrders: 3, note: '改价仅影响后续新订单与续费' });
      }
      if (r3 === 'active') {
        p.active = Boolean(b.active);
        return delay({ id: p.id, active: p.active, holderCount: p.holderCount });
      }
      if (!r3 && method === 'PATCH') {
        const priceChanged = b.priceCents !== undefined && Number(b.priceCents) !== p.priceCents;
        if (priceChanged) p.priceHistory = [{ priceCents: p.priceCents, monthlyCredits: p.monthlyCredits, changedAt: new Date().toISOString(), changedBy: meId, reason: String(b.reason) }, ...(p.priceHistory ?? [])];
        Object.assign(p, { name: b.name ?? p.name, monthlyCredits: b.monthlyCredits ?? p.monthlyCredits, priceCents: b.priceCents ?? p.priceCents, maxFiles: b.maxFiles ?? p.maxFiles, updatedAt: new Date().toISOString() });
        return delay({ plan: p, priceChanged });
      }
    }
    if (key === 'GET /catalog/rules') return delay({ items: rules });
    if (r1 === 'rules' && r2) {
      const r = rules.find((x) => x.toolSlug === decodeURIComponent(r2)) ?? fail(404, 'NOT_FOUND', '规则不存在');
      if (r3 === 'impact') {
        const nc = Number(query.newCreditCost);
        return delay({ toolSlug: r.toolSlug, currentCreditCost: r.creditCost, newCreditCost: nc, affectedUsers: 42, recentCredits: Math.abs(r.recentUsage.credits), projectedCredits: r.recentUsage.calls * nc, monthlyDeltaCredits: r.recentUsage.calls * (nc - r.creditCost), note: '不追溯旧交易' });
      }
      if (method === 'PATCH') {
        const before = { creditCost: r.creditCost, minPlan: r.minPlan, maxFilesPerTask: r.maxFilesPerTask };
        const prev = r.ruleVersion;
        Object.assign(r, { creditCost: b.creditCost ?? r.creditCost, minPlan: b.minPlan ?? r.minPlan, maxFilesPerTask: b.maxFilesPerTask ?? r.maxFilesPerTask });
        const changed = JSON.stringify(before) !== JSON.stringify({ creditCost: r.creditCost, minPlan: r.minPlan, maxFilesPerTask: r.maxFilesPerTask });
        if (changed) r.ruleVersion = `v${Number(prev.slice(1, 2)) + 1}.0.0`;
        return delay({ toolSlug: r.toolSlug, ruleVersion: r.ruleVersion, previousVersion: prev, before, after: before });
      }
    }
  }

  // alerts
  if (r0 === 'alerts') {
    if (key === 'GET /alerts/meta')
      return delay({ rules: alertRules, channel: { configured: false, note: null }, policy: { consecutiveThreshold: 3, silenceMs: 1800000, maxRetries: 3, evalIntervalMs: 300000 } });
    if (key === 'GET /alerts/stats')
      return delay({
        windowDays: 7, total: alertEvents.length, resolved: alertEvents.filter((a) => a.resolvedAt).length, unresolved: alertEvents.filter((a) => !a.resolvedAt).length,
        sendFailed: alertEvents.filter((a) => a.status === 'failed').length, suppressed: alertEvents.filter((a) => a.status === 'suppressed').length,
        byRule: alertRules.map((r) => ({ ruleKey: r.key, title: r.name, count: alertEvents.filter((a) => a.ruleKey === r.key).length })).filter((x) => x.count > 0),
        avgResolveMinutes: 38,
      });
    if (key === 'GET /alerts') {
      const list = alertEvents.filter(
        (a) => (!query.severity || a.severity === query.severity) && (!query.status || a.status === query.status) && (query.onlyOpen !== 'true' || !a.resolvedAt)
      );
      const p = Number(query.page) || 1;
      const size = Number(query.pageSize) || 20;
      return delay({
        items: list.slice((p - 1) * size, p * size),
        pagination: { total: list.length, page: p, pageSize: size },
        firingCount: alertRules.filter((r) => r.firing).length,
        bySeverity: ['P0', 'P1', 'P2'].map((s) => ({ severity: s, count: list.filter((a) => a.severity === s).length })),
      });
    }
    if (r1 === 'events' && r2) return delay(alertEvents.find((a) => a.id === r2) ?? fail(404, 'NOT_FOUND', '告警事件不存在'));
    if (key === 'POST /alerts/evaluate') return delay({ evaluated: alertRules.length, triggered: ['stale_pending_orders'], recovered: [], collectFailed: [] });
    if (key === 'POST /alerts/reset-states') {
      const targets = alertRules.filter((r) => !b.ruleKey || r.key === b.ruleKey);
      for (const r of targets) {
        r.firing = false;
        r.hitStreak = 0;
      }
      return delay({ reset: targets.length });
    }
    if (r2 === 'ack') {
      const r = alertRules.find((x) => x.key === decodeURIComponent(r1!)) ?? fail(404, 'NOT_FOUND', '规则不存在');
      r.firing = false;
      r.hitStreak = 0;
      r.lastResolvedAt = new Date().toISOString();
      return delay({ ruleKey: r.key, firing: false });
    }
  }

  return NOT_HANDLED;
}

/**
 * 前端内存 Mock 服务：在 api-client 层拦截 /api/admin/v1 请求，纯前端即可跑通全部页面。
 * 数据仅存内存，刷新页面后重置。设置 VITE_API_MOCK=false 切回真实后端。
 *
 * 登录：任意用户名 + 任意密码；动态验证码输入 123456（或任意恢复码）。
 */

import { ApiError } from '../lib/api-client';
import { permissionsForRole } from '../lib/permissions';
import { NOT_HANDLED, extraRequest } from './extra';

type Query = Record<string, string | number | boolean | undefined | null>;

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

// ---------- 数据 ----------

interface MAdmin {
  id: string;
  username: string;
  name: string;
  role: 'SUPER_ADMIN' | 'OPERATOR' | 'SUPPORT' | 'FINANCE' | 'AUDITOR';
  status: 'ACTIVE' | 'DISABLED';
  totpEnabled: boolean;
  mustBindTotp: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
}

const admins: MAdmin[] = [
  { id: 'adm_1', username: 'ops', name: '运营主管', role: 'SUPER_ADMIN', status: 'ACTIVE', totpEnabled: true, mustBindTotp: false, lastLoginAt: ago(5), lastLoginIp: '127.0.0.1', createdAt: ago(60 * 24 * 90) },
  { id: 'adm_2', username: 'zhang.yun', name: '张芸', role: 'OPERATOR', status: 'ACTIVE', totpEnabled: true, mustBindTotp: false, lastLoginAt: ago(180), lastLoginIp: '10.0.0.21', createdAt: ago(60 * 24 * 60) },
  { id: 'adm_3', username: 'li.support', name: '李客服', role: 'SUPPORT', status: 'ACTIVE', totpEnabled: true, mustBindTotp: false, lastLoginAt: ago(60 * 20), lastLoginIp: '10.0.0.34', createdAt: ago(60 * 24 * 40) },
  { id: 'adm_4', username: 'wang.fin', name: '王财务', role: 'FINANCE', status: 'ACTIVE', totpEnabled: false, mustBindTotp: true, lastLoginAt: null, lastLoginIp: null, createdAt: ago(60 * 24 * 10) },
  { id: 'adm_5', username: 'zhao.audit', name: '赵审计', role: 'AUDITOR', status: 'DISABLED', totpEnabled: true, mustBindTotp: false, lastLoginAt: ago(60 * 24 * 20), lastLoginIp: '10.0.0.8', createdAt: ago(60 * 24 * 70) },
];
let me: MAdmin = admins[0]!;

const NAMES = ['陈小明', '林晓', '周杰', '吴雪', '郑凯', '孙悦', '马超', '朱琳', '胡斌', '郭靖', '何静', '高远', '罗兰', '梁山', '宋佳'];
interface MUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  planId: string;
  planExpiresAt: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  balance: number;
  bonusBalance: number;
  monthlyQuota: number;
  sessions: number;
  createdAt: string;
  lastLoginAt: string | null;
}
const users: MUser[] = Array.from({ length: 26 }, (_, i) => {
  const plan = ['free', 'pro', 'vip'][i % 3]!;
  return {
    id: `u_${1000 + i}`,
    email: i % 4 === 3 ? null : `user${i + 1}@example.com`,
    phone: i % 4 === 3 ? `1380000${String(1000 + i)}` : null,
    name: NAMES[i % NAMES.length]!,
    planId: plan,
    planExpiresAt: plan === 'free' ? null : ago(-60 * 24 * (10 + i)),
    status: i === 5 || i === 17 ? 'SUSPENDED' : i === 23 ? 'DELETED' : 'ACTIVE',
    balance: 50 + ((i * 37) % 400),
    bonusBalance: i % 5 === 0 ? 20 : 0,
    monthlyQuota: plan === 'free' ? 100 : plan === 'pro' ? 1000 : 5000,
    sessions: i % 6 === 0 ? 0 : 1 + (i % 3),
    createdAt: ago(60 * 24 * (3 + i * 4)),
    lastLoginAt: i % 7 === 6 ? null : ago(30 + i * 90),
  };
});

interface MOrder {
  orderNo: string;
  userId: string;
  planId: string;
  amountCents: number;
  currency: string;
  periodMonths: number;
  channel: 'WECHAT' | 'ALIPAY';
  status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDING' | 'REFUNDED' | 'CLOSED';
  creditsGranted: number;
  thirdPartyTradeNo: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  refundedAt: string | null;
  createdAt: string;
}
const STATUSES: MOrder['status'][] = ['PAID', 'PAID', 'PAID', 'PENDING', 'PAID', 'FAILED', 'CLOSED', 'REFUNDED', 'PAID', 'REFUNDING'];
const orders: MOrder[] = Array.from({ length: 34 }, (_, i) => {
  const status = STATUSES[i % STATUSES.length]!;
  const created = ago(60 * (i * 9 + 1));
  const paid = status === 'PAID' || status === 'REFUNDED' || status === 'REFUNDING';
  const months = [1, 3, 12][i % 3]!;
  return {
    orderNo: `HY2610${String(20 - (i % 20)).padStart(2, '0')}${String(100000 + i * 7919).slice(0, 6)}`,
    userId: users[i % users.length]!.id,
    planId: i % 2 ? 'pro' : 'vip',
    amountCents: [1990, 4990, 19900][i % 3]!,
    currency: 'CNY',
    periodMonths: months,
    channel: i % 2 ? 'WECHAT' : 'ALIPAY',
    status,
    creditsGranted: paid ? months * 500 : 0,
    thirdPartyTradeNo: paid ? `4200${2000000000 + i * 13579}` : null,
    paidAt: paid ? created : null,
    expiresAt: status === 'PENDING' ? ago(-30) : null,
    refundedAt: status === 'REFUNDED' ? ago(60 * i) : null,
    createdAt: created,
  };
});
const userBrief = (id: string): { id: string; email: string | null; phone: string | null; name: string | null } | null => {
  const u = users.find((x) => x.id === id);
  return u ? { id: u.id, email: u.email, phone: u.phone, name: u.name } : null;
};

interface MRecon {
  id: string;
  channel: string;
  orderNo: string;
  localStatus: string;
  channelStatus: string;
  diffType: string;
  action: string | null;
  note: string | null;
  handledBy: string | null;
  handledAt: string | null;
  createdAt: string;
}
const DIFFS = ['PAID_LOCAL_PENDING', 'PAID_LOCAL_UNKNOWN', 'AMOUNT_MISMATCH', 'DUPLICATE_NOTIFY'];
const recons: MRecon[] = Array.from({ length: 14 }, (_, i) => {
  const o = orders[(i * 3) % orders.length]!;
  const done = i % 5 === 4;
  return {
    id: `rec_${i + 1}`,
    channel: o.channel,
    orderNo: o.orderNo,
    localStatus: i % 4 === 0 ? 'PENDING' : 'PAID',
    channelStatus: i % 4 === 1 ? 'NOT_FOUND' : 'SUCCESS',
    diffType: DIFFS[i % 4]!,
    action: done ? 'MANUAL_DONE' : null,
    note: done ? '已联系用户确认收款' : null,
    handledBy: done ? 'zhang.yun' : null,
    handledAt: done ? ago(60 * i) : null,
    createdAt: ago(60 * (i * 5 + 2)),
  };
});

// ---------- 路由 ----------

type Body = Record<string, unknown> | undefined;

export async function mockRequest(method: string, path: string, query: Query = {}, body?: unknown): Promise<unknown> {
  const b = (body ?? {}) as Body & Record<string, unknown>;
  const seg = path.split('?')[0]!.split('/').filter(Boolean);
  const [r0, r1, r2] = seg;
  const key = `${method} /${seg.join('/')}`;

  // ----- auth -----
  if (r0 === 'auth') {
    if (key === 'POST /auth/login') {
      if (b.step === 'password') {
        const hit = admins.find((a) => a.username === b.username) ?? admins[0]!;
        if (hit.status === 'DISABLED') fail(403, 'ADMIN_DISABLED', '账号已被禁用');
        me = hit;
        return delay({ mfaRequired: true, mfaToken: 'mock-mfa', mustBindTotp: false });
      }
      if (String(b.code ?? '').length < 6) fail(401, 'INVALID_CODE', '动态验证码错误（Mock 模式输入 123456）');
      return delay({ tokens: { accessToken: 'mock-access', refreshToken: 'mock-refresh', expiresIn: 900 }, admin: me });
    }
    if (key === 'GET /auth/me') return delay({ admin: me, permissions: permissionsForRole(me.role) });
    if (key === 'POST /auth/logout') return delay({ ok: true });
    if (key === 'POST /auth/refresh') return delay({ accessToken: 'mock-access', refreshToken: 'mock-refresh' });
    if (key === 'GET /auth/sessions')
      return delay({
        currentSessionId: 'ses_1',
        items: [
          { id: 'ses_1', ip: '127.0.0.1', userAgent: 'Chrome / Windows', createdAt: ago(30), lastUsedAt: ago(1), expiresAt: ago(-60 * 24 * 7), revokedAt: null },
          { id: 'ses_2', ip: '10.0.0.21', userAgent: 'Safari / macOS', createdAt: ago(60 * 24), lastUsedAt: ago(60 * 5), expiresAt: ago(-60 * 24 * 6), revokedAt: null },
        ],
      });
    if (key === 'POST /auth/sessions/revoke-all') return delay({ revoked: 1 });
    if (r1 === 'sessions' && method === 'DELETE') return delay({ ok: true });
    if (key === 'POST /auth/password') return delay({ ok: true });
    if (key === 'POST /auth/totp/rebind') return delay({ mfaRequired: true, mfaToken: 'mock-mfa', mustBindTotp: true });
    if (key === 'POST /auth/totp/bind') return delay({ secret: 'MOCKSECRETMOCKSECRET', otpauthUrl: 'otpauth://totp/mock?secret=MOCKSECRETMOCKSECRET' });
    if (key === 'POST /auth/totp/confirm')
      return delay({
        tokens: { accessToken: 'mock-access', refreshToken: 'mock-refresh', expiresIn: 900 },
        admin: me,
        recoveryCodes: ['MOCK000001', 'MOCK000002', 'MOCK000003', 'MOCK000004'],
      });
  }

  // ----- dashboard -----
  if (r0 === 'dashboard') {
    const scope = (query.scope as string) ?? 'today';
    const k = scope === 'd30' ? 30 : scope === 'd7' ? 7 : 1;
    return delay({
      scope,
      generatedAt: ago(2),
      stale: false,
      metrics: {
        users: { registrations: 12 * k, activeLogins: 86 * Math.ceil(k / 2), suspended: 2 },
        payment: { orders: 24 * k, paidOrders: 18 * k, successRate: 0.75, gmvCents: 89200 * k, avgOrderCents: 4955, refundedOrders: k },
        anomalies: { stalePendingOrders: 3, invalidSignatureEvents: 1, duplicateNotifyEvents: 2, openReconciliations: recons.filter((r) => !r.action).length, mismatchedAccounts: 0, negativeAccounts: 0 },
        credits: { grantedTotal: 120000 * k, consumedTotal: 83000 * k, adjustCount: 2, adjustNet: 300 },
        system: { dbOk: true, snapshotAgeMs: 120000 },
      },
    });
  }

  // ----- users -----
  if (r0 === 'users') {
    if (!r1) {
      const s = String(query.search ?? '').trim();
      let list = users.filter(
        (u) =>
          (!s || [u.email, u.phone, u.name].some((f) => f?.includes(s))) &&
          (!query.status || u.status === query.status) &&
          (!query.planId || u.planId === String(query.planId).trim())
      );
      list = [...list];
      return delay(
        page(
          list.map((u) => ({ ...u, sessions: undefined, monthlyQuota: undefined })),
          query
        )
      );
    }
    const u = users.find((x) => x.id === r1) ?? fail(404, 'NOT_FOUND', '用户不存在');
    if (!r2 && method === 'GET')
      return delay({
        user: u,
        creditAccount: { balance: u.balance, bonusBalance: u.bonusBalance, monthlyQuota: u.monthlyQuota },
        activeSessions: u.sessions,
        recentOrders: orders.filter((o) => o.userId === u.id).slice(0, 5),
      });
    if (r2 === 'status') {
      if (String(b.reason ?? '').length < 2) fail(400, 'VALIDATION_ERROR', '请填写原因');
      const revoked = u.sessions;
      u.status = b.status as MUser['status'];
      if (u.status === 'SUSPENDED') u.sessions = 0;
      return delay({ ok: true, revokedSessions: revoked });
    }
    if (r2 === 'sessions') {
      const revoked = u.sessions;
      u.sessions = 0;
      return delay({ revokedSessions: revoked });
    }
  }

  // ----- orders -----
  if (r0 === 'orders') {
    if (!r1) {
      const list = orders.filter(
        (o) =>
          (!query.orderNo || o.orderNo.includes(String(query.orderNo).trim())) &&
          (!query.status || o.status === query.status) &&
          (!query.channel || o.channel === query.channel)
      );
      const res = page(list.map((o) => ({ ...o, user: userBrief(o.userId) })), query);
      return delay({
        ...res,
        summary: { totalAmountCents: list.filter((o) => o.status === 'PAID').reduce((s, o) => s + o.amountCents, 0), paidCount: list.filter((o) => o.status === 'PAID').length },
      });
    }
    const o = orders.find((x) => x.orderNo === decodeURIComponent(r1)) ?? fail(404, 'NOT_FOUND', '订单不存在');
    if (!r2) {
      const u = users.find((x) => x.id === o.userId);
      const paid = o.status !== 'PENDING' && o.status !== 'FAILED' && o.status !== 'CLOSED';
      return delay({
        order: { ...o, user: userBrief(o.userId) },
        user: u ? { id: u.id, email: u.email, phone: u.phone, name: u.name, planId: u.planId, status: u.status } : null,
        events: [
          { id: `${o.orderNo}-e1`, provider: o.channel, eventType: 'ORDER_CREATED', signatureValid: true, processed: true, processError: null, createdAt: o.createdAt },
          ...(paid
            ? [{ id: `${o.orderNo}-e2`, provider: o.channel, eventType: 'PAYMENT_SUCCESS', signatureValid: true, processed: true, processError: null, createdAt: o.paidAt ?? o.createdAt }]
            : o.status === 'FAILED'
              ? [{ id: `${o.orderNo}-e2`, provider: o.channel, eventType: 'PAYMENT_NOTIFY', signatureValid: false, processed: false, processError: '验签失败', createdAt: o.createdAt }]
              : []),
        ],
        grantTransaction: paid
          ? { id: `tx_${o.orderNo}`, type: 'GRANT', status: 'COMPLETED', amount: o.creditsGranted, deltaBalance: o.creditsGranted, deltaBonus: 0, balanceAfter: (u?.balance ?? 0) + o.creditsGranted, createdAt: o.paidAt ?? o.createdAt }
          : null,
      });
    }
    if (r2 === 'sync') {
      const settled = o.status === 'PENDING';
      if (settled) {
        o.status = 'PAID';
        o.paidAt = new Date().toISOString();
        o.creditsGranted = o.periodMonths * 500;
      }
      return delay({ localStatus: o.status, channelStatus: 'SUCCESS', settled, note: settled ? undefined : '本地状态与渠道一致' });
    }
  }

  // ----- reconciliations -----
  if (r0 === 'reconciliations') {
    if (!r1) {
      const list = recons.filter(
        (r) =>
          (!query.diffType || r.diffType === query.diffType) &&
          (!query.orderNo || r.orderNo.includes(String(query.orderNo).trim())) &&
          (query.pendingOnly !== 'true' || r.action === null)
      );
      const groupCounts: Record<string, number> = {};
      for (const r of recons) groupCounts[r.diffType] = (groupCounts[r.diffType] ?? 0) + 1;
      return delay({ ...page(list, query), groupCounts });
    }
    const rec = recons.find((x) => x.id === r1) ?? fail(404, 'NOT_FOUND', '对账记录不存在');
    if (!r2) return delay(rec);
    if (r2 === 'handle') {
      rec.action = String(b.action);
      rec.note = String(b.note);
      rec.handledBy = me.username;
      rec.handledAt = new Date().toISOString();
      return delay({ id: rec.id, action: rec.action, handledAt: rec.handledAt });
    }
    if (r2 === 'resettle') {
      rec.action = 'AUTO_SETTLED';
      rec.localStatus = 'PAID';
      rec.handledAt = new Date().toISOString();
      return delay({ orderNo: rec.orderNo, settled: true, localStatus: 'PAID', note: '' });
    }
  }

  // ----- admins -----
  if (r0 === 'admins') {
    if (!r1 && method === 'GET') return delay(page(admins, query));
    if (!r1 && method === 'POST') {
      if (admins.some((a) => a.username === b.username)) fail(409, 'CONFLICT', '用户名已存在');
      const created: MAdmin = {
        id: `adm_${admins.length + 1}`,
        username: String(b.username),
        name: String(b.name),
        role: b.role as MAdmin['role'],
        status: 'ACTIVE',
        totpEnabled: false,
        mustBindTotp: true,
        lastLoginAt: null,
        lastLoginIp: null,
        createdAt: new Date().toISOString(),
      };
      admins.push(created);
      return delay(created);
    }
    const a = admins.find((x) => x.id === r1) ?? fail(404, 'NOT_FOUND', '管理员不存在');
    if (method === 'GET') return delay(a);
    if (method === 'PUT') {
      if (a.id === me.id) fail(400, 'VALIDATION_ERROR', '不能操作自己的账号');
      if (b.role) a.role = b.role as MAdmin['role'];
      if (b.status) a.status = b.status as MAdmin['status'];
      return delay(a);
    }
  }

  const extra = await extraRequest(method, seg, query, body, me.id);
  if (extra !== NOT_HANDLED) return extra;
  return fail(404, 'NOT_FOUND', `Mock 未实现：${key}`);
}

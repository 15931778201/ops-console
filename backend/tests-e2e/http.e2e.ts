/**
 * E2E · HTTP 契约与 RBAC（真实 HTTP 服务器 + 真实 PostgreSQL）
 * 运行：npm run test:e2e:http
 *
 * 覆盖（服务层测不到、只有过中间件链才暴露的问题）：
 *  - 统一 envelope：成功 {success,data} / 失败 {success:false,error:{code,message,details}}
 *  - 路由挂载顺序：/api/admin/v1/* 不被旧 /api/admin 通道吞掉
 *  - 认证中间件：无令牌 401、用户令牌不可用于 admin 通道
 *  - RBAC 逐角色矩阵：SUPER_ADMIN 全通 / OPERATOR 可写订单 / SUPPORT 只读 / FINANCE 只读订单 / AUDITOR 只读
 *  - Zod 校验失败统一 400 VALIDATION_FAILED + 字段级 details
 *  - 分页响应结构：items/pagination 与 items/summary、items/groupCounts 同级
 *  - 未知路由 404
 */

import 'dotenv/config';
import type { Server } from 'node:http';
import app from '../src/index';
import prisma from '../src/lib/prisma';
import {
  currentTotp,
  e2eName,
  E2E_PASSWORD,
  enableTotpDirectly,
  createTestAdmin,
  cleanupE2eData,
  Check,
} from './harness';
import type { AdminRole } from '@prisma/client';

const SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';

let server: Server;
let baseUrl: string;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function errCode(r: ApiResult): string {
  return ((r.body.error as { code?: string } | undefined)?.code) ?? '';
}

/** 完成 HTTP 两步登录，返回 access token */
async function httpLogin(tag: string, role: AdminRole): Promise<string> {
  const admin = await createTestAdmin(tag, role);
  await enableTotpDirectly(admin.id, SECRET);
  const username = e2eName(tag);

  const s1 = await api('POST', '/api/admin/v1/auth/login', {
    body: { step: 'password', username, password: E2E_PASSWORD },
  });
  const mfaToken = (s1.body.data as { mfaToken?: string } | undefined)?.mfaToken;
  if (!mfaToken) throw new Error(`第一步登录失败：${JSON.stringify(s1.body)}`);

  const s2 = await api('POST', '/api/admin/v1/auth/login', {
    body: { step: 'totp', mfaToken, code: currentTotp(SECRET), username },
  });
  const tokens = (s2.body.data as { tokens?: { accessToken?: string } } | undefined)?.tokens;
  if (!tokens?.accessToken) throw new Error(`第二步登录失败：${JSON.stringify(s2.body)}`);
  return tokens.accessToken;
}

async function main(): Promise<void> {
  const c = new Check();
  console.log('\n=== E2E: HTTP 契约与 RBAC ===');

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // ---------- 1. 未认证行为 ----------
  const noAuth = await api('GET', '/api/admin/v1/admins');
  c.eq('未认证 → 401', noAuth.status, 401);
  c.eq('未认证错误码为 admin 体系', errCode(noAuth), 'ADMIN_INVALID_CREDENTIALS');

  const badToken = await api('GET', '/api/admin/v1/admins', { token: 'not-a-jwt' });
  c.eq('伪造令牌 → 401', badToken.status, 401);

  // 用户端令牌不可用于 admin 通道（密钥隔离）
  const { signAccessToken } = await import('../src/lib/jwt');
  const userToken = signAccessToken({ sub: 'someone', role: 'USER' } as never);
  const crossToken = await api('GET', '/api/admin/v1/admins', { token: userToken });
  c.eq('用户令牌访问 admin 通道 → 401', crossToken.status, 401);

  // ---------- 2. 旧 break-glass 通道仍独立 ----------
  const legacy = await api('GET', '/api/admin/users');
  c.eq('旧 /api/admin/users 未认证 → 401 UNAUTHORIZED', errCode(legacy), 'UNAUTHORIZED');

  // ---------- 3. Zod 校验统一 400 ----------
  const badLogin = await api('POST', '/api/admin/v1/auth/login', {
    body: { step: 'password' },
  });
  c.eq('缺参登录 → 400', badLogin.status, 400);
  c.eq('缺参错误码 VALIDATION_FAILED', errCode(badLogin), 'VALIDATION_FAILED');
  c.ok(
    'details 为字段级数组',
    Array.isArray((badLogin.body.error as { details?: unknown } | undefined)?.details)
  );

  const badEnvelop = badLogin.body;
  c.eq('失败响应 success=false', badEnvelop.success, false);
  c.ok(
    '错误对象含 message',
    typeof (badEnvelop.error as { message?: unknown } | undefined)?.message === 'string'
  );

  // ---------- 4. 各角色登录并取令牌 ----------
  const superToken = await httpLogin('http_super', 'SUPER_ADMIN');
  const operatorToken = await httpLogin('http_operator', 'OPERATOR');
  const supportToken = await httpLogin('http_support', 'SUPPORT');
  const financeToken = await httpLogin('http_finance', 'FINANCE');
  const auditorToken = await httpLogin('http_auditor', 'AUDITOR');

  c.ok('五角色均可完成两步登录', Boolean(superToken && operatorToken && supportToken && supportToken));

  // ---------- 5. RBAC 矩阵 ----------
  // 只读业务接口：五角色均持有
  const readCases: Array<[string, string]> = [
    ['GET', '/api/admin/v1/users?page=1&pageSize=5'],
    ['GET', '/api/admin/v1/orders?page=1&pageSize=5'],
    ['GET', '/api/admin/v1/reconciliations?page=1&pageSize=5'],
  ];

  for (const token of [superToken, operatorToken, supportToken, financeToken, auditorToken]) {
    for (const [method, path] of readCases) {
      const r = await api(method, path, { token });
      c.ok(`只读接口放行 ${method} ${path}`, r.status === 200, { status: r.status, body: r.body });
    }
  }

  // /admins 需 admin:manage —— 仅 SUPER_ADMIN
  const superAdmins = await api('GET', '/api/admin/v1/admins', { token: superToken });
  c.eq('SUPER_ADMIN 可读管理员列表', superAdmins.status, 200);
  for (const [label, token] of [
    ['OPERATOR', operatorToken],
    ['SUPPORT', supportToken],
    ['FINANCE', financeToken],
    ['AUDITOR', auditorToken],
  ] as const) {
    const r = await api('GET', '/api/admin/v1/admins', { token });
    c.eq(`${label} 读管理员列表 → 403`, r.status, 403);
  }

  // 订单补结算：SUPER_ADMIN / OPERATOR 可写（order:sync）
  const syncNo = 'E2E_HTTP_NO_ORDER';
  const opSync = await api('POST', `/api/admin/v1/orders/${syncNo}/sync`, { token: operatorToken });
  c.ok('OPERATOR 可调用 order:sync（404 而非 403）', opSync.status === 404, {
    status: opSync.status,
    code: errCode(opSync),
  });
  const supSync = await api('POST', `/api/admin/v1/orders/${syncNo}/sync`, { token: superToken });
  c.eq('SUPER_ADMIN 同样穿透到业务层', supSync.status, 404);

  const supportSync = await api('POST', `/api/admin/v1/orders/${syncNo}/sync`, { token: supportToken });
  c.eq('SUPPORT 调用 order:sync → 403', supportSync.status, 403);
  c.eq('SUPPORT 403 错误码为权限不足', errCode(supportSync), 'ADMIN_PERMISSION_DENIED');

  const auditorSync = await api('POST', `/api/admin/v1/orders/${syncNo}/sync`, { token: auditorToken });
  c.eq('AUDITOR 调用 order:sync → 403', auditorSync.status, 403);

  const financeSync = await api('POST', `/api/admin/v1/orders/${syncNo}/sync`, { token: financeToken });
  c.eq('FINANCE 调用 order:sync → 403', financeSync.status, 403);

  // 对账处理（reconcile:handle）：SUPER_ADMIN / OPERATOR；FINANCE 在矩阵中仅只读
  const handleUrl = '/api/admin/v1/reconciliations/00000000-0000-4000-8000-000000000000/handle';
  const handleBody = { action: 'MANUAL_DONE', note: 'E2E HTTP 测试' };
  const opHandle = await api('POST', handleUrl, { token: operatorToken, body: handleBody });
  c.ok('OPERATOR 可调用 reconcile:handle（404 而非 403）', opHandle.status === 404, {
    status: opHandle.status,
  });
  const supHandle = await api('POST', handleUrl, { token: superToken, body: handleBody });
  c.eq('SUPER_ADMIN 可处理对账差异', supHandle.status, 404);
  const financeHandle = await api('POST', handleUrl, { token: financeToken, body: handleBody });
  c.eq('FINANCE 无 reconcile:handle → 403', financeHandle.status, 403);
  const supportHandle = await api('POST', handleUrl, { token: supportToken, body: handleBody });
  c.eq('SUPPORT 处理对账 → 403', supportHandle.status, 403);

  // 用户禁用（user:disable）：SUPER_ADMIN / OPERATOR
  // 目标不存在时 service 抛 ValidationError → 400（不是 404），故此处断言 400 以证明已穿透到业务层
  const disableUrl = '/api/admin/v1/users/00000000-0000-4000-8000-000000000000/status';
  const supDisable = await api('POST', disableUrl, {
    token: superToken,
    body: { status: 'SUSPENDED', reason: 'E2E HTTP 测试' },
  });
  c.eq('SUPER_ADMIN 禁用用户穿透到业务层（用户不存在→400）', supDisable.status, 400);
  c.eq('业务层错误码为 VALIDATION_FAILED', errCode(supDisable), 'VALIDATION_FAILED');
  const opDisable = await api('POST', disableUrl, {
    token: operatorToken,
    body: { status: 'SUSPENDED', reason: 'E2E HTTP 测试' },
  });
  c.eq('OPERATOR 持有 user:disable（穿透到业务层）', opDisable.status, 400);
  const supportDisable = await api('POST', disableUrl, {
    token: supportToken,
    body: { status: 'SUSPENDED', reason: 'E2E HTTP 测试' },
  });
  c.eq('SUPPORT 禁用用户 → 403', supportDisable.status, 403);
  const financeDisable = await api('POST', disableUrl, {
    token: financeToken,
    body: { status: 'SUSPENDED', reason: 'E2E HTTP 测试' },
  });
  c.eq('FINANCE 禁用用户 → 403', financeDisable.status, 403);

  // 强制下线（session:revoke）：SUPER_ADMIN / OPERATOR
  const revokeUrl = '/api/admin/v1/users/00000000-0000-4000-8000-000000000000/sessions/revoke';
  const opRevoke = await api('POST', revokeUrl, { token: operatorToken });
  c.ok('OPERATOR 可强制下线（穿透到业务层）', opRevoke.status === 400, { status: opRevoke.status });
  const auditorRevoke = await api('POST', revokeUrl, { token: auditorToken });
  c.eq('AUDITOR 强制下线 → 403', auditorRevoke.status, 403);

  // 管理员账号管理：仅 SUPER_ADMIN（admin:manage）
  const opCreate = await api('POST', '/api/admin/v1/admins', {
    token: operatorToken,
    body: { username: 'e2e_http_op', name: 'X', password: 'AnotherPassw0rd', role: 'AUDITOR' },
  });
  c.eq('OPERATOR 创建管理员 → 403', opCreate.status, 403);
  const supCreate = await api('POST', '/api/admin/v1/admins', {
    token: superToken,
    body: { username: 'e2e_http_super', name: 'X', password: 'AnotherPassw0rd', role: 'AUDITOR' },
  });
  c.eq('SUPER_ADMIN 创建重复用户名 → 400', supCreate.status, 400);
  const supCreateOk = await api('POST', '/api/admin/v1/admins', {
    token: superToken,
    body: { username: 'e2e_http_new', name: '新管理员', password: 'AnotherPassw0rd', role: 'AUDITOR' },
  });
  c.eq('SUPER_ADMIN 创建管理员成功 → 201', supCreateOk.status, 201);
  const newAdminId = (supCreateOk.body.data as { id?: string }).id ?? '';
  const selfDisable = await api('PUT', `/api/admin/v1/admins/${newAdminId}`, {
    token: superToken,
    body: { status: 'DISABLED' },
  });
  c.eq('禁用新管理员成功', selfDisable.status, 200);
  const tryDisableSelf = await api('PUT', `/api/admin/v1/admins/${newAdminId}`, {
    token: superToken,
    body: { status: 'ACTIVE' },
  });
  c.eq('同一人可继续变更（非自身）', tryDisableSelf.status, 200);

  // ---------- 6. 分页响应结构 ----------
  const ordersRes = await api('GET', '/api/admin/v1/orders?page=1&pageSize=2', { token: supportToken });
  const data = ordersRes.body.data as Record<string, unknown>;
  c.ok('分页响应含 items', Array.isArray(data.items));
  const pagination = data.pagination as Record<string, unknown> | undefined;
  c.ok('分页响应含 pagination', pagination !== undefined);
  c.ok('pagination 含 page/pageSize/total', typeof pagination?.page === 'number' && typeof pagination?.total === 'number');
  c.ok('订单列表 summary 与 items 同级', data.summary !== undefined);
  c.eq('成功响应 success=true', ordersRes.body.success, true);

  const reconRes = await api('GET', '/api/admin/v1/reconciliations?page=1&pageSize=2', {
    token: supportToken,
  });
  const reconData = reconRes.body.data as Record<string, unknown>;
  c.ok('对账列表 groupCounts 与 items 同级', reconData.groupCounts !== undefined);

  const metaRes = await api('GET', '/api/admin/v1/reconciliations/meta', { token: supportToken });
  c.eq('meta 返回四类差异', ((metaRes.body.data as { diffTypes?: string[] }).diffTypes ?? []).length, 4);

  // 参数校验：非法枚举
  const badEnum = await api('GET', '/api/admin/v1/orders?status=NOT_A_STATUS', {
    token: superToken,
  });
  c.eq('非法枚举 → 400', badEnum.status, 400);
  c.eq('非法枚举错误码 VALIDATION_FAILED', errCode(badEnum), 'VALIDATION_FAILED');

  const badPage = await api('GET', '/api/admin/v1/orders?page=0', { token: superToken });
  c.eq('page=0 → 400', badPage.status, 400);

  const overSize = await api('GET', '/api/admin/v1/orders?pageSize=999', { token: superToken });
  c.eq('pageSize 超限 → 400', overSize.status, 400);

  // ---------- 7. 会话管理与登出 ----------
  const meRes = await api('GET', '/api/admin/v1/auth/me', { token: operatorToken });
  const me = meRes.body.data as { admin?: { role?: string }; permissions?: string[] };
  c.eq('me 返回当前角色', me.admin?.role, 'OPERATOR');
  c.ok('me 返回权限码数组', Array.isArray(me.permissions) && me.permissions.length > 0);

  const sessionsRes = await api('GET', '/api/admin/v1/auth/sessions', { token: operatorToken });
  const sessions = sessionsRes.body.data as { items?: unknown[]; currentSessionId?: string };
  c.ok('会话列表返回 items', Array.isArray(sessions.items) && sessions.items.length >= 1);
  c.ok('会话列表标记当前会话', typeof sessions.currentSessionId === 'string');

  const logoutRes = await api('POST', '/api/admin/v1/auth/logout', { token: operatorToken });
  c.eq('登出返回 200', logoutRes.status, 200);
  const afterLogout = await api('GET', '/api/admin/v1/auth/me', { token: operatorToken });
  c.eq('登出后 access token 失效 → 401', afterLogout.status, 401);

  // refresh 轮换
  const refreshTarget = await httpLogin('http_refresh', 'AUDITOR');
  c.ok('刷新目标账号可登录', Boolean(refreshTarget));
  const s1 = await api('POST', '/api/admin/v1/auth/login', {
    body: {
      step: 'password',
      username: e2eName('http_refresh'),
      password: E2E_PASSWORD,
    },
  });
  const mfaToken = (s1.body.data as { mfaToken: string }).mfaToken;
  const s2 = await api('POST', '/api/admin/v1/auth/login', {
    body: {
      step: 'totp',
      mfaToken,
      code: currentTotp(SECRET),
      username: e2eName('http_refresh'),
    },
  });
  const rt = (s2.body.data as { tokens: { refreshToken: string } }).tokens.refreshToken;
  const rot = await api('POST', '/api/admin/v1/auth/refresh', { body: { refreshToken: rt } });
  c.eq('refresh 轮换返回 200', rot.status, 200);
  const replay = await api('POST', '/api/admin/v1/auth/refresh', { body: { refreshToken: rt } });
  c.ok('旧 refresh 重放被拒（非 200）', replay.status >= 400, { status: replay.status });

  // ---------- 8. 404 与调账入口关闭 ----------
  const notFound = await api('GET', '/api/admin/v1/no-such-module', { token: superToken });
  c.eq('未知后台路由 → 404', notFound.status, 404);

  // 旧单人调账入口：仍然关闭（A6.5 走审批流）
  // 说明：/api/admin 是 break-glass 旧通道，先过 ADMIN_USER_IDS 白名单（本地未配置→401），
  // 因此这里断言"绝不2xx 调账成功"；白名单放行后handler 仍会抛 503 FEATURE_DISABLED。
  const adjust = await api('POST', '/api/admin/adjust-credits', {
    token: superToken,
    body: { userId: 'x', amount: 100, reason: 'E2E' },
  });
  c.ok('旧单人调账入口绝不成功', adjust.status !== 200, { status: adjust.status, code: errCode(adjust) });

  // ---------- 9. 审批流 HTTP 契约与 RBAC（A6.5）----------
  //注意：operatorToken 在 §7 已被登出作废，这里重新登录取新令牌
  const freshOperatorToken = await httpLogin('http_operator2', 'OPERATOR');
  // 读接口：持 approval:read 的四个角色可读（OPERATOR/SUPPORT/FINANCE/AUDITOR）
  const approvalReads = ['/api/admin/v1/approvals?page=1&pageSize=5', '/api/admin/v1/approvals/mine-count'];
  for (const [label, token] of [
    ['SUPER_ADMIN', superToken],
    ['OPERATOR', freshOperatorToken],
    ['SUPPORT', supportToken],
    ['FINANCE', financeToken],
    ['AUDITOR', auditorToken],
  ] as Array<[string, string]>) {
    for (const path of approvalReads) {
      const r = await api('GET', path, { token });
      c.ok(`${label} 可读 ${path}`, r.status === 200, { status: r.status, body: r.body });
    }
  }

  // 类型字典
  const types = await api('GET', '/api/admin/v1/approvals/meta/types', { token: auditorToken });
  c.eq('类型字典 200', types.status, 200);

  // 提交申请：需 credit:adjust:apply（矩阵里只有 OPERATOR + SUPER_ADMIN 持有；
  // FINANCE 是审批侧角色，有 P 无 A，这正是"申请与审批分离"的体现）
  const targetUser = await prisma.user.create({
    data: { email: `e2e_http_apv_${Date.now()}@test.local`, passwordHash: 'x', name: 'E2E-HttpApv', planId: 'free' },
  });
  await prisma.creditAccount.create({ data: { userId: targetUser.id, balance: 200, bonusBalance: 0 } });

  const submitBody = {
    type: 'CREDIT_ADJUST',
    payload: { userId: targetUser.id, deltaBalance: 50, deltaBonus: 0, reason: 'HTTP 层联调补偿' },
    reason: 'HTTP 层联调补偿',
    ticketNo: 'T-HTTP-1',
  };
  const supSubmit = await api('POST', '/api/admin/v1/approvals', { token: supportToken, body: submitBody });
  c.eq('SUPPORT 无 credit:adjust:apply → 403', supSubmit.status, 403);
  const finSubmit = await api('POST', '/api/admin/v1/approvals', { token: financeToken, body: submitBody });
  c.eq('FINANCE 是审批侧角色，无 apply → 403', finSubmit.status, 403);
  const audSubmit = await api('POST', '/api/admin/v1/approvals', { token: auditorToken, body: submitBody });
  c.eq('AUDITOR 无 credit:adjust:apply → 403', audSubmit.status, 403);

  const opSubmit = await api('POST', '/api/admin/v1/approvals', { token: freshOperatorToken, body: submitBody });
  c.eq('OPERATOR 可提交调账申请（201 Created）', opSubmit.status, 201, opSubmit.body);
  const approvalId = ((opSubmit.body as { data?: { id?: string } }).data?.id ?? '') as string;
  c.ok('返回审批单 ID', approvalId.length > 0);

  // 校验错误：payload 缺 reason → 400 VALIDATION_FAILED
  const badSubmit = await api('POST', '/api/admin/v1/approvals', {
    token: freshOperatorToken,
    body: { type: 'CREDIT_ADJUST', payload: { userId: targetUser.id, deltaBalance: 1 }, reason: '少字段' },
  });
  c.eq('payload 缺字段 → 400', badSubmit.status, 400);
  c.eq('校验错误码为 VALIDATION_FAILED', errCode(badSubmit), 'VALIDATION_FAILED');

  // 自批自发：OPERATOR 提交后自己批准 → 409
  const selfApprove = await api('POST', `/api/admin/v1/approvals/${approvalId}/approve`, {
    token: freshOperatorToken,
    body: { note: '自己批自己' },
  });
  c.eq('申请人自批 → 409', selfApprove.status, 409);
  c.eq('自批错误码为 ADMIN_APPROVAL_CONFLICT', errCode(selfApprove), 'ADMIN_APPROVAL_CONFLICT');

  // 无 credit:adjust:execute 的角色不能批准
  const supportApprove = await api('POST', `/api/admin/v1/approvals/${approvalId}/approve`, {
    token: supportToken,
    body: { note: '客服越权' },
  });
  c.eq('SUPPORT 批准 → 403', supportApprove.status, 403);

  // SUPER_ADMIN 批准 → 批准即执行（设计文档：服务端同事务执行，审批人无需手动代劳）
  const approve = await api('POST', `/api/admin/v1/approvals/${approvalId}/approve`, {
    token: superToken,
    body: { note: '已核实工单' },
  });
  c.eq('SUPER_ADMIN 批准成功', approve.status, 200, approve.body);
  c.eq('批准后直接返回 EXECUTED（批准即执行）', (approve.body as { data?: { status?: string } }).data?.status, 'EXECUTED');
  const acct = await prisma.creditAccount.findUnique({ where: { userId: targetUser.id } });
  c.eq('HTTP 层批准后余额已入账', acct?.balance, 250);
  const txnCount = await prisma.creditTransaction.count({
    where: { userId: targetUser.id, referenceId: `approval:${approvalId}` },
  });
  c.eq('流水按审批单 ID 关联，可反查', txnCount, 1);

  // 再调 /execute → 409（不重复入账）
  const again = await api('POST', `/api/admin/v1/approvals/${approvalId}/execute`, { token: superToken });
  c.eq('重复执行 → 409', again.status, 409);
  c.eq('重复执行错误码为 ADMIN_APPROVAL_CONFLICT', errCode(again), 'ADMIN_APPROVAL_CONFLICT');
  const acct2 = await prisma.creditAccount.findUnique({ where: { userId: targetUser.id } });
  c.eq('重复执行后余额不变', acct2?.balance, 250);

  // 撤回：仅申请人；非申请人 403
  const otherCancel = await api('POST', `/api/admin/v1/approvals/${approvalId}/cancel`, { token: auditorToken });
  c.eq('非申请人撤回 → 403', otherCancel.status, 403);

  // 未认证访问
  const anonApprovals = await api('GET', '/api/admin/v1/approvals');
  c.eq('未认证访问审批列表 → 401', anonApprovals.status, 401);

  const s = c.summary('HTTP 契约与 RBAC');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  await cleanupE2eData();
  if (s.failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('E2E HTTP 套件异常：', err);
  try {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  } catch {
    /* ignore */
  }
  try {
    await cleanupE2eData();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
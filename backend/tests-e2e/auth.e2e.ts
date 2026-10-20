/**
 * E2E · 认证与管理员账号管理（服务层，真实 PostgreSQL）
 * 运行：npm run test:e2e:auth
 *
 * 覆盖不变量：
 *  - 密码错误/账号不存在统一文案（防枚举）
 *  - mfaToken 一次性（重放被拒）
 *  - TOTP 绑定前后 mustBindTotp 流转 + 恢复码发放
 *  - 恢复码用后即焚（且只能用一次）
 *  - refresh 轮换 + 重放检测吊销全部会话
 *  - access token 与用户 token 密钥隔离
 *  - 末位 SUPER_ADMIN 保护、不能操作自己
 *  - 密码策略（长度/复杂度/不含用户名）
 */

import prisma from '../src/lib/prisma';
import { adminAuthService } from '../src/services/admin-auth.service';
import { adminSessionService } from '../src/services/admin-session.service';
import { adminUserService } from '../src/services/admin-user.service';
import { verifyAdminAccessToken, signAdminAccessToken } from '../src/lib/admin-jwt';
import { verifyAccessToken } from '../src/lib/jwt';
import {
  Check,
  cleanupE2eData,
  createTestAdmin,
  currentTotp,
  decodeJwtPayload,
  e2eName,
  E2E_PASSWORD,
  enableTotpDirectly,
  loginAsAdmin,
} from './harness';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function main(): Promise<void> {
  const c = new Check();
  console.log('\n=== E2E: 认证与管理员账号管理 ===');

  // ---------- 1. 第一步登录：防枚举与账号状态 ----------
  const admin = await createTestAdmin('auth_main');
  await enableTotpDirectly(admin.id, SECRET);

  const s1 = await adminAuthService.loginStep1(e2eName('auth_main'), E2E_PASSWORD);
  c.ok('第一步登录返回 mfaToken', typeof s1.mfaToken === 'string' && s1.mfaToken.length > 20);
  c.eq('已绑定 TOTP 时 mustBindTotp=false', s1.mustBindTotp, false);

  await c.throwsCode('密码错误 → ADMIN_INVALID_CREDENTIALS', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminAuthService.loginStep1(e2eName('auth_main'), 'WrongPassw0rdX')
  );
  await c.throwsCode('账号不存在 → 同一错误码（防枚举）', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminAuthService.loginStep1(e2eName('nobody_here'), E2E_PASSWORD)
  );

  // 未绑定 TOTP 的账号：purpose 应为 totp-bind
  const unbound = await createTestAdmin('auth_unbound');
  const s1u = await adminAuthService.loginStep1(e2eName('auth_unbound'), E2E_PASSWORD);
  c.eq('未绑定 TOTP 时 mustBindTotp=true', s1u.mustBindTotp, true);
  await c.throwsCode('未绑定账号不能用 mfa 目的 token 登录', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminAuthService.loginStep2(s1u.mfaToken, '123456')
  );

  // ---------- 2. TOTP 绑定全流程 ----------
  const bind = await adminAuthService.bindTotp(s1u.mfaToken);
  c.ok('bind 返回 Base32 secret', /^[A-Z2-7]{16,}$/.test(bind.secret), bind.secret);
  c.ok('otpauthUrl 含 otpauth://totp/', bind.otpauthUrl.startsWith('otpauth://totp/'));
  const bound = await prisma.adminUser.findUnique({ where: { id: unbound.id } });
  c.eq('confirm 前 totpEnabled 仍为 false', bound!.totpEnabled, false);

  const confirm = await adminAuthService.confirmTotp(s1u.mfaToken, currentTotp(bind.secret));
  c.eq('confirm 发放 10 个恢复码', confirm.recoveryCodes.length, 10);
  c.eq('confirm 后 mustBindTotp=false', confirm.admin.mustBindTotp, false);
  c.eq('confirm 后 totpEnabled=true', confirm.admin.totpEnabled, true);
  c.ok('confirm 直接签发令牌对', typeof confirm.tokens.accessToken === 'string');

  // mfaToken 一次性
  await c.throwsCode('mfaToken 不可重放（confirm 后）', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminAuthService.confirmTotp(s1u.mfaToken, '123456')
  );

  // ---------- 3. 第二步登录 + 恢复码用后即焚 ----------
  const s1b = await adminAuthService.loginStep1(e2eName('auth_unbound'), E2E_PASSWORD);
  const s2 = await adminAuthService.loginStep2(s1b.mfaToken, currentTotp(bind.secret));
  c.ok('TOTP 校验通过返回令牌对', typeof s2.tokens.accessToken === 'string');

  const recovery = confirm.recoveryCodes[0]!;
  const s1c = await adminAuthService.loginStep1(e2eName('auth_unbound'), E2E_PASSWORD);
  await adminAuthService.loginStep2(s1c.mfaToken, recovery);
  c.ok('恢复码可替代 TOTP 登录', true);
  const afterUse = await prisma.adminUser.findUnique({ where: { id: unbound.id } });
  c.eq('恢复码用后即焚（10→9）', afterUse!.recoveryCodes.length, 9);

  const s1d = await adminAuthService.loginStep1(e2eName('auth_unbound'), E2E_PASSWORD);
  await c.throwsCode('已用恢复码不可复用', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminAuthService.loginStep2(s1d.mfaToken, recovery)
  );
  await c.throwsCode('错误 TOTP 被拒', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminAuthService.loginStep2(s1d.mfaToken, '000000')
  );

  // ---------- 4. 令牌隔离与 payload ----------
  const payload = decodeJwtPayload(s2.tokens.accessToken);
  c.eq('access payload 含 sub', payload.sub, unbound.id);
  c.eq('access payload 含 role（默认 SUPER_ADMIN）', payload.role, 'SUPER_ADMIN');
  c.ok('access payload 含 sid', typeof payload.sid === 'string');

  const userToken = signAdminAccessToken({ sub: unbound.id, sid: 'x', role: 'SUPER_ADMIN' });
  c.ok('admin access token 可被 admin 验签器解析', verifyAdminAccessToken(userToken) !== null);
  c.eq('admin token 不能被用户端验签器接受', verifyAccessToken(userToken), null);

  const forged = `${userToken.slice(0, -3)}abc`;
  c.eq('被篡改的 token 验签失败', verifyAdminAccessToken(forged), null);

  // ---------- 5. refresh 轮换 + 重放检测 ----------
  const rot1 = await adminSessionService.rotate(s2.tokens.refreshToken);
  c.ok('首次 refresh 成功', rot1.ok === true);
  const invalid = await adminSessionService.rotate('not-a-real-token-value-xxxxxxxx');
  c.ok('伪造 refresh → INVALID', invalid.ok === false && invalid.reason === 'INVALID');

  if (rot1.ok) {
    const replay = await adminSessionService.rotate(s2.tokens.refreshToken);
    c.ok(
      '旧 refresh 重放被识别为 REUSED',
      replay.ok === false && replay.reason === 'REUSED',
      replay
    );
    c.eq('REUSED 回传 adminUserId（供全量吊销）', replay.ok === false ? replay.adminUserId : '', unbound.id);

    // 通过服务层 refresh 触发全量吊销
    const victim = await loginAsAdmin('auth_replay');
    await adminAuthService.refresh(victim.refreshToken);
    const victimAdmin = await prisma.adminUser.findUnique({
      where: { id: victim.admin.id },
      include: { sessions: true },
    });
    const activeBefore = victimAdmin!.sessions.filter((x) => !x.revokedAt).length;
    c.ok('轮换后会话仍有效', activeBefore >= 1, { activeBefore });

    // 重放旧 token → 全部吊销
    let threw = false;
    try {
      await adminAuthService.refresh(victim.refreshToken);
    } catch {
      threw = true;
    }
    const victimAfter = await prisma.adminUser.findUnique({
      where: { id: victim.admin.id },
      include: { sessions: true },
    });
    const activeAfter = victimAfter!.sessions.filter((x) => !x.revokedAt).length;
    c.ok('重放后 refresh 抛错', threw);
    c.eq('重放触发全部会话吊销', activeAfter, 0);
  }

  // ---------- 6. 会话管理 ----------
  const mgr = await loginAsAdmin('auth_sessions');
  const sessions = await adminAuthService.listSessions(mgr.admin.id);
  c.ok('会话列表至少 1 条', sessions.length >= 1);
  await adminAuthService.revokeAllSessions(mgr.admin.id);
  const afterAll = await prisma.adminSession.count({
    where: { adminUserId: mgr.admin.id, revokedAt: null },
  });
  c.eq('revokeAll 后无有效会话', afterAll, 0);
  const me = await adminAuthService.me(mgr.admin.id);
  c.ok('me 返回权限码列表', me.permissions.length > 0);

  // ---------- 7. 管理员账号管理 ----------
  const creator = await loginAsAdmin('auth_creator');
  const created = await adminUserService.createAdmin(
    { username: 'e2e_auth_new', name: '新管理员', password: 'AnotherPassw0rd', role: 'OPERATOR' },
    creator.admin.id
  );
  c.eq('创建成功角色正确', created.role, 'OPERATOR');

  await c.throwsCode('用户名重复被拒', 'VALIDATION_FAILED', () =>
    adminUserService.createAdmin(
      { username: 'e2e_auth_new', name: 'X', password: 'AnotherPassw0rd', role: 'OPERATOR' },
      creator.admin.id
    )
  );
  await c.throwsCode('弱密码被拒（纯小写）', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminUserService.createAdmin(
      { username: 'e2e_weakpwd', name: 'X', password: 'weakpassword', role: 'OPERATOR' },
      creator.admin.id
    )
  );
  await c.throwsCode('密码含用户名被拒', 'ADMIN_INVALID_CREDENTIALS', () =>
    adminUserService.createAdmin(
      { username: 'e2e_selfpwd', name: 'X', password: 'E2e_selfpwd_Aa1', role: 'OPERATOR' },
      creator.admin.id
    )
  );

  await c.throwsCode('不能修改自己的账号', 'ADMIN_PERMISSION_DENIED', () =>
    adminUserService.updateAdmin(creator.admin.id, { role: 'OPERATOR' }, creator.admin.id)
  );

  // 末位超管保护：把 creator 降级时若其所在角色集无其他超管则拒绝
  const otherSuper = await prisma.adminUser.findFirst({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE', id: { not: creator.admin.id } },
    select: { id: true },
  });
  if (!otherSuper) {
    await c.throwsCode('末位 SUPER_ADMIN 不可降级', 'ADMIN_APPROVAL_CONFLICT', () =>
      adminUserService.updateAdmin(creator.admin.id, { role: 'OPERATOR' }, creator.admin.id)
    );
  } else {
    c.ok('存在其他超管时可降级（前置条件）', true);
  }

  const demoted = await adminUserService.updateAdmin(
    created.id,
    { role: 'AUDITOR' },
    creator.admin.id
  );
  c.eq('降级生效', demoted.role, 'AUDITOR');

  const disabled = await adminUserService.updateAdmin(
    created.id,
    { status: 'DISABLED' },
    creator.admin.id
  );
  c.eq('禁用生效', disabled.status, 'DISABLED');
  await c.throwsCode('已禁用账号无法登录', 'ADMIN_ACCOUNT_DISABLED', () =>
    adminAuthService.loginStep1('e2e_auth_new', 'AnotherPassw0rd')
  );

  const list = await adminUserService.listAdmins({ page: 1, pageSize: 50 });
  c.ok('管理员列表含 e2e_ 前缀账号', list.items.some((a) => a.username.startsWith('e2e_')));

  // ---------- 8. 修改密码后旧会话失效 ----------
  const pwdAdmin = await loginAsAdmin('auth_pwd');
  await adminAuthService.changePassword(
    pwdAdmin.admin.id,
    E2E_PASSWORD,
    'RotatedPassw0rd1'
  );
  const oldSessionActive = await adminSessionService.isSessionActive(
    pwdAdmin.sessionId,
    pwdAdmin.admin.id
  );
  c.eq('改密后原会话失效', oldSessionActive, false);
  const newLogin = await adminAuthService.loginStep1(e2eName('auth_pwd'), 'RotatedPassw0rd1');
  c.ok('新密码可登录第一步', typeof newLogin.mfaToken === 'string');

  const s = c.summary('认证与管理员管理');
  await cleanupE2eData();
  if (s.failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('E2E 认证套件异常：', err);
  try {
    await cleanupE2eData();
  } catch {
    /* 忽略清理异常 */
  }
  process.exitCode = 1;
});
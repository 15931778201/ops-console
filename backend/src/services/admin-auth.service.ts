/**
 * 运营后台认证服务（两步登录）
 * 流程：
 *   1) POST /auth/login {step:'password'} → 校验密码 → 签发 mfaToken（5 分钟）
 *      - 已绑定 TOTP → purpose='mfa'，继续第二步
 *      - 未绑定（首次登录/重绑）→ purpose='totp-bind'，前端引导绑定
 *   2a) POST /auth/login {step:'totp', mfaToken, code} → 校验 TOTP/恢复码 → 令牌对
 *   2b) POST /auth/totp/bind {mfaToken} → 生成 pending secret（加密存储）+ otpauth URL
 *   2c) POST /auth/totp/confirm {mfaToken, code} → 验证扫码结果 → 启用 TOTP + 恢复码 + 令牌对
 * 安全：统一错误文案防账号枚举；mfaToken 一次性（Redis  claim，降级时仅靠短时效）；
 *       恢复码 hash 存储、用后即焚；连续失败由限流层兜底。
 */

import bcrypt from 'bcryptjs';
import type { AdminRole, AdminUser } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../lib/config';
import {
  signAdminMfaToken,
  verifyAdminMfaToken,
  adminAccessExpiresInSec,
} from '../lib/admin-jwt';
import { parseAdminDuration } from '../lib/admin-jwt';
import { encryptField, decryptField } from '../lib/field-cipher';
import {
  generateTotpSecret,
  buildOtpauthUrl,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchRecoveryCode,
} from '../lib/totp';
import { adminSessionService, type AdminTokenPair } from './admin-session.service';
import { permissionsForRole } from '../lib/admin-permissions';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { idempotency, getClient } from '../lib/redis';
import { AdminError, ErrorCode, RateLimitError } from '../lib/errors';

export interface AdminContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface AdminView {
  id: string;
  username: string;
  name: string;
  role: AdminRole;
  totpEnabled: boolean;
  mustBindTotp: boolean;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdAt: Date;
}

function toAdminView(admin: AdminUser): AdminView {
  return {
    id: admin.id,
    username: admin.username,
    name: admin.name,
    role: admin.role,
    totpEnabled: admin.totpEnabled,
    mustBindTotp: admin.mustBindTotp,
    lastLoginAt: admin.lastLoginAt,
    lastLoginIp: admin.lastLoginIp,
    createdAt: admin.createdAt,
  };
}

/** 统一的登录失败错误（防账号枚举：不区分用户不存在/密码错误/TOTP 错误） */
function invalidCredentials(): AdminError {
  return new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '用户名或密码错误', 401);
}

/** mfaToken 一次性消费（Redis 不可用时降级为不拦截，生产环境 Redis 为必配） */
async function consumeMfaToken(jti: string): Promise<boolean> {
  const ttlSec = Math.ceil(parseAdminDuration(config.ADMIN_MFA_TOKEN_EXPIRES_IN) / 1000);
  return idempotency.set(`mfa:${jti}`, ttlSec);
}

/**
 * TOTP 尝试次数防护：同一 mfaToken 最多 5 次校验机会（6 位码暴力空间 10^6）。
 * Redis 不可用时放行（由登录限流与 mfaToken 短时效兜底）。
 */
async function checkTotpAttempts(jti: string): Promise<boolean> {
  const c = getClient();
  if (!c) return true;
  try {
    const n = await c.incr(`mfa-attempts:${jti}`);
    if (n === 1) {
      await c.expire(`mfa-attempts:${jti}`, 600);
    }
    return n <= 5;
  } catch {
    return true;
  }
}

async function loadActiveAdmin(adminId: string): Promise<AdminUser> {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId } });
  if (!admin) throw invalidCredentials();
  if (admin.status !== 'ACTIVE') {
    throw new AdminError(ErrorCode.ADMIN_ACCOUNT_DISABLED, '账号已被禁用', 403);
  }
  return admin;
}

export const adminAuthService = {
  /** 第一步：用户名 + 密码 */
  async loginStep1(
    username: string,
    password: string,
    context: AdminContext = {}
  ): Promise<{ mfaRequired: true; mfaToken: string; mustBindTotp: boolean }> {
    const admin = await prisma.adminUser.findUnique({
      where: { username: username.trim() },
    });

    if (!admin) {
      await audit.record({
        actorType: 'ADMIN',
        action: 'admin.login_failed',
        reason: 'user_not_found',
        metadata: { ip: context.ip },
        requestId: context.requestId,
      });
      throw invalidCredentials();
    }

    if (admin.status !== 'ACTIVE') {
      await audit.record({
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'admin.login_failed',
        reason: `status:${admin.status}`,
        requestId: context.requestId,
      });
      throw new AdminError(ErrorCode.ADMIN_ACCOUNT_DISABLED, '账号已被禁用', 403);
    }

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      await audit.record({
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'admin.login_failed',
        reason: 'bad_password',
        metadata: { ip: context.ip },
        requestId: context.requestId,
      });
      throw invalidCredentials();
    }

    // mustBindTotp 是首次登录/重绑状态的明确标记；同时对历史脏数据采用安全兜底：
    // 只要 TOTP 未完整启用（开关或密钥缺失），就进入绑定流程，不能把用户引导到一个不存在的动态码。
    const mustBindTotp = requiresTotpBinding(admin);
    const purpose = mustBindTotp ? 'totp-bind' : 'mfa';
    const mfaToken = signAdminMfaToken(admin.id, purpose);
    logger.info({ adminId: admin.id, purpose, mustBindTotp }, 'admin_login_step1_passed');
    return { mfaRequired: true, mfaToken, mustBindTotp };
  },

  /** 第二步：TOTP 校验（恢复码可替代，用后即焚） */
  async loginStep2(
    mfaToken: string,
    code: string,
    context: AdminContext = {}
  ): Promise<{ tokens: AdminTokenPair; admin: AdminView }> {
    const payload = verifyAdminMfaToken(mfaToken, 'mfa');
    if (!payload) throw invalidCredentials();

    const allowed = await checkTotpAttempts(payload.jti);
    if (!allowed) {
      throw new RateLimitError('验证尝试次数过多，请重新登录');
    }

    const claimed = await consumeMfaToken(payload.jti);
    if (!claimed) {
      await audit.record({
        actorType: 'ADMIN',
        actorId: payload.sub,
        action: 'admin.login_failed',
        reason: 'mfa_token_replayed',
        requestId: context.requestId,
      });
      throw invalidCredentials();
    }

    const admin = await loadActiveAdmin(payload.sub);
    if (!admin.totpEnabled || !admin.totpSecret) {
      throw new AdminError(ErrorCode.ADMIN_MFA_REQUIRED, '请先绑定动态验证码', 401);
    }

    let secret: string;
    try {
      secret = decryptField(admin.totpSecret);
    } catch (err) {
      logger.error({ err, adminId: admin.id }, 'admin_totp_secret_decrypt_failed');
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '服务器配置错误', 401);
    }

    const recoveryIndex = matchRecoveryCode(admin.recoveryCodes, code);
    const totpOk = verifyTotp(secret, code);

    if (!totpOk && recoveryIndex < 0) {
      await audit.record({
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'admin.login_failed',
        reason: 'bad_totp',
        metadata: { ip: context.ip },
        requestId: context.requestId,
      });
      throw invalidCredentials();
    }

    // 恢复码命中：从列表中移除（用后即焚）
    if (!totpOk && recoveryIndex >= 0) {
      const remaining = admin.recoveryCodes.filter((_, i) => i !== recoveryIndex);
      await prisma.adminUser.update({
        where: { id: admin.id },
        data: { recoveryCodes: remaining },
      });
      logger.warn(
        { adminId: admin.id, remaining: remaining.length },
        'admin_recovery_code_consumed'
      );
      await audit.record({
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'admin.recovery_code_used',
        requestId: context.requestId,
      });
    }

    const tokens = await this.completeLogin(admin, context);
    return { tokens, admin: toAdminView(admin) };
  },

  /** 绑定流程：生成 pending secret（未验证前 totpEnabled 仍为 false） */
  async bindTotp(
    mfaToken: string,
    context: AdminContext = {}
  ): Promise<{ secret: string; otpauthUrl: string }> {
    const payload = verifyAdminMfaToken(mfaToken, 'totp-bind');
    if (!payload) throw invalidCredentials();

    const admin = await loadActiveAdmin(payload.sub);

    const secret = generateTotpSecret();
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpSecret: encryptField(secret), totpEnabled: false, mustBindTotp: true },
    });
    await audit.record({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.totp_bind_initiated',
      requestId: context.requestId,
    });
    return {
      secret,
      otpauthUrl: buildOtpauthUrl(secret, admin.username, config.ADMIN_TOTP_ISSUER),
    };
  },

  /** 绑定流程确认：验证 App 生成的码 → 启用 TOTP + 发放恢复码 + 令牌对 */
  async confirmTotp(
    mfaToken: string,
    code: string,
    context: AdminContext = {}
  ): Promise<{ tokens: AdminTokenPair; admin: AdminView; recoveryCodes: string[] }> {
    const payload = verifyAdminMfaToken(mfaToken, 'totp-bind');
    if (!payload) throw invalidCredentials();

    const allowed = await checkTotpAttempts(payload.jti);
    if (!allowed) {
      throw new RateLimitError('验证尝试次数过多，请重新开始绑定');
    }

    const claimed = await consumeMfaToken(payload.jti);
    if (!claimed) throw invalidCredentials();

    const admin = await loadActiveAdmin(payload.sub);
    if (!admin.totpSecret) {
      throw new AdminError(ErrorCode.ADMIN_MFA_REQUIRED, '请先初始化动态验证码绑定', 401);
    }

    let secret: string;
    try {
      secret = decryptField(admin.totpSecret);
    } catch (err) {
      logger.error({ err, adminId: admin.id }, 'admin_totp_secret_decrypt_failed');
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '服务器配置错误', 401);
    }

    if (!verifyTotp(secret, code)) {
      await audit.record({
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'admin.totp_bind_failed',
        reason: 'bad_code',
        requestId: context.requestId,
      });
      throw invalidCredentials();
    }

    const recoveryCodes = generateRecoveryCodes();
    const updated = await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        totpEnabled: true,
        mustBindTotp: false,
        recoveryCodes: recoveryCodes.map(hashRecoveryCode),
      },
    });

    const tokens = await this.completeLogin(updated, context);
    await audit.record({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.totp_bound',
      requestId: context.requestId,
    });
    logger.info({ adminId: admin.id }, 'admin_totp_bound');
    return { tokens, admin: toAdminView(updated), recoveryCodes };
  },

  /** 刷新令牌（轮换 + 重放检测） */
  async refresh(refreshToken: string, context: AdminContext = {}): Promise<AdminTokenPair> {
    const result = await adminSessionService.rotate(refreshToken);
    if (!result.ok) {
      if (result.reason === 'REUSED') {
        // 重放响应：凭 rotate 带回的 adminUserId 吊销全部会话并告警
        await adminSessionService.handleReuse(result.adminUserId ?? null, context.requestId);
        throw new AdminError(ErrorCode.ADMIN_TOKEN_REUSED, '登录状态已失效，请重新登录', 401);
      }
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '登录状态已失效，请重新登录', 401);
    }
    return result.tokens;
  },

  async logout(sessionId: string, adminId: string, requestId?: string): Promise<void> {
    await adminSessionService.revokeById(sessionId, adminId);
    await audit.record({ actorType: 'ADMIN', actorId: adminId, action: 'admin.logout', requestId });
  },

  /** 当前管理员信息 + 权限码列表（前端据此渲染菜单与按钮） */
  async me(adminId: string): Promise<{ admin: AdminView; permissions: string[] }> {
    const admin = await loadActiveAdmin(adminId);
    return { admin: toAdminView(admin), permissions: permissionsForRole(admin.role) };
  },

  async listSessions(adminId: string): ReturnType<typeof adminSessionService.listForAdmin> {
    return adminSessionService.listForAdmin(adminId);
  },

  async revokeSession(sessionId: string, adminId: string, requestId?: string): Promise<void> {
    await adminSessionService.revokeById(sessionId, adminId);
    await audit.record({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'admin.session_revoked',
      targetType: 'AdminSession',
      targetId: sessionId,
      requestId,
    });
  },

  async revokeAllSessions(adminId: string, requestId?: string): Promise<number> {
    const count = await adminSessionService.revokeAll(adminId, 'admin_logout_all');
    await audit.record({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'admin.sessions_revoked_all',
      reason: `count:${count}`,
      requestId,
    });
    return count;
  },

  /** 修改密码：成功后吊销全部会话（含当前） */
  async changePassword(
    adminId: string,
    oldPassword: string,
    newPassword: string,
    requestId?: string
  ): Promise<void> {
    const admin = await loadActiveAdmin(adminId);
    const valid = await bcrypt.compare(oldPassword, admin.passwordHash);
    if (!valid) {
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '原密码错误', 401);
    }
    await prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash: await bcrypt.hash(newPassword, 12) },
    });
    await adminSessionService.revokeAll(adminId, 'admin_password_changed');
    await audit.record({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'admin.password_changed',
      requestId,
    });
  },

  /**
   * 发起 TOTP 重绑（设置页）：需先通过密码复核，返回 totp-bind 用途的 mfaToken，
   * 随后复用 bindTotp/confirmTotp。重绑期间旧 TOTP 仍然有效（confirm 成功后替换）。
   */
  async initiateTotpRebind(
    adminId: string,
    password: string,
    context: AdminContext = {}
  ): Promise<{ mfaToken: string }> {
    const admin = await loadActiveAdmin(adminId);
    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '密码错误', 401);
    }
    await audit.record({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'admin.totp_rebind_initiated',
      requestId: context.requestId,
    });
    return { mfaToken: signAdminMfaToken(adminId, 'totp-bind') };
  },

  /** 登录成功公共路径：更新登录信息 + 签发会话 + 审计 */
  async completeLogin(admin: AdminUser, context: AdminContext = {}): Promise<AdminTokenPair> {
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date(), lastLoginIp: context.ip },
    });
    const tokens = await adminSessionService.createSession(admin.id, admin.role, {
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await audit.record({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.login',
      requestId: context.requestId,
    });
    return tokens;
  },
};

export { toAdminView, adminAccessExpiresInSec };

/**
 * 首次登录分流规则的纯函数，供回归测试复用。
 * TOTP 状态不完整时必须进入绑定流程，避免显示无法获得的动态码输入框。
 */
export function requiresTotpBinding(
  admin: Pick<AdminUser, 'mustBindTotp' | 'totpEnabled' | 'totpSecret'>
): boolean {
  return admin.mustBindTotp || !admin.totpEnabled || !admin.totpSecret;
}

/**
 * 运营后台 JWT 工具（独立于用户端令牌体系）
 * - Access Token：短时效（默认 15m），payload { sub, sid, role }
 * - 密钥：ADMIN_JWT_SECRET（生产强制独立配置；缺省由 JWT_SECRET 域分离派生）
 * - MFA 中间令牌：两步登录的密码→TOTP 间隙，5 分钟，purpose 区分 mfa/totp-bind
 *
 * 安全意图：用户端 token 泄露不授予后台能力，后台 token 也不能调用用户端接口
 * （两套 secret 不同，jwt.verify 互不通过）。
 */

import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { config, adminJwtSecret } from './config';

export interface AdminAccessTokenPayload {
  sub: string;
  sid: string;
  role: string;
}

export type MfaTokenPurpose = 'mfa' | 'totp-bind';

export interface AdminMfaTokenPayload {
  sub: string;
  purpose: MfaTokenPurpose;
  /** 一次性标识：登录成功后消费，防 mfaToken 重放 */
  jti: string;
}

function signOptions(expiresIn: string): jwt.SignOptions {
  return { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] };
}

export function signAdminAccessToken(payload: AdminAccessTokenPayload): string {
  return jwt.sign(payload, adminJwtSecret(), signOptions(config.ADMIN_ACCESS_EXPIRES_IN));
}

export function verifyAdminAccessToken(token: string): AdminAccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, adminJwtSecret()) as AdminAccessTokenPayload;
    if (typeof decoded.sub !== 'string' || typeof decoded.sid !== 'string') return null;
    if (typeof decoded.role !== 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}

/** 签发 MFA 中间令牌（两步登录第一步成功后） */
export function signAdminMfaToken(adminId: string, purpose: MfaTokenPurpose): string {
  return jwt.sign(
    { sub: adminId, purpose, jti: randomBytes(8).toString('hex') },
    adminJwtSecret(),
    signOptions(config.ADMIN_MFA_TOKEN_EXPIRES_IN)
  );
}

/** 校验 MFA 中间令牌；purpose 不匹配时拒绝（防止 mfa 令牌冒充 bind 流程） */
export function verifyAdminMfaToken(
  token: string,
  expectedPurpose: MfaTokenPurpose
): { sub: string; jti: string } | null {
  try {
    const decoded = jwt.verify(token, adminJwtSecret()) as AdminMfaTokenPayload;
    if (typeof decoded.sub !== 'string') return null;
    if (typeof decoded.jti !== 'string') return null;
    if (decoded.purpose !== expectedPurpose) return null;
    return { sub: decoded.sub, jti: decoded.jti };
  } catch {
    return null;
  }
}

/** access token 有效期（秒，供前端刷新调度） */
export function adminAccessExpiresInSec(): number {
  return Math.floor(parseAdminDuration(config.ADMIN_ACCESS_EXPIRES_IN) / 1000);
}

/** 解析 '15m' / '30d' / '3600' 等时长为毫秒 */
export function parseAdminDuration(value: string): number {
  const m = value.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
  if (!m) return 15 * 60 * 1000;
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] ?? 's').toLowerCase();
  const factor: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * (factor[unit] ?? 1000);
}

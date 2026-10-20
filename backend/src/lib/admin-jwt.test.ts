import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signAdminAccessToken,
  verifyAdminAccessToken,
  signAdminMfaToken,
  verifyAdminMfaToken,
  adminAccessExpiresInSec,
  parseAdminDuration,
} from './admin-jwt';

describe('admin-jwt（独立令牌体系）', () => {
  const payload = { sub: 'admin-1', sid: 'sess-1', role: 'SUPER_ADMIN' };

  it('access token 签发后可验出 payload', () => {
    const token = signAdminAccessToken(payload);
    const decoded = verifyAdminAccessToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe('admin-1');
    expect(decoded!.sid).toBe('sess-1');
    expect(decoded!.role).toBe('SUPER_ADMIN');
  });

  it('与用户端密钥隔离：用户 secret 签的 token 在后台验不过', () => {
    // 用户端 secret 为 JWT_SECRET；admin 派生/独立 secret 不同 → verify 必须失败
    const userLike = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '15m' });
    expect(verifyAdminAccessToken(userLike)).toBeNull();
  });

  it('反向隔离：后台 token 用用户 secret 验不过', () => {
    const adminToken = signAdminAccessToken(payload);
    expect(() => jwt.verify(adminToken, process.env.JWT_SECRET!)).toThrow();
  });

  it('畸形/篡改 token 返回 null', () => {
    expect(verifyAdminAccessToken('not-a-token')).toBeNull();
    expect(verifyAdminAccessToken('')).toBeNull();
    const token = signAdminAccessToken(payload);
    const tampered = `${token.slice(0, -2)}xx`;
    expect(verifyAdminAccessToken(tampered)).toBeNull();
  });

  it('过期 token 返回 null', () => {
    const token = jwt.sign(payload, adminSecretForTest(), { expiresIn: '-10s' });
    expect(verifyAdminAccessToken(token)).toBeNull();
  });

  it('mfa token 校验 purpose', () => {
    const mfa = signAdminMfaToken('admin-1', 'mfa');
    const bind = signAdminMfaToken('admin-1', 'totp-bind');
    const mfaPayload = verifyAdminMfaToken(mfa, 'mfa');
    expect(mfaPayload?.sub).toBe('admin-1');
    expect(typeof mfaPayload?.jti).toBe('string');
    // 防冒充：mfa 令牌不能当 bind 用，反之亦然
    expect(verifyAdminMfaToken(mfa, 'totp-bind')).toBeNull();
    expect(verifyAdminMfaToken(bind, 'mfa')).toBeNull();
  });

  it('每次签发的 mfa token jti 不同（一次性消费的基础）', () => {
    expect(signAdminMfaToken('a', 'mfa')).not.toBe(signAdminMfaToken('a', 'mfa'));
  });

  it('adminAccessExpiresInSec 与配置一致（默认 15m → 900s）', () => {
    expect(adminAccessExpiresInSec()).toBe(900);
  });
});

describe('parseAdminDuration', () => {
  it('解析各单位', () => {
    expect(parseAdminDuration('30d')).toBe(30 * 86400000);
    expect(parseAdminDuration('15m')).toBe(15 * 60000);
    expect(parseAdminDuration('3600')).toBe(3600 * 1000); // 无单位按秒
    expect(parseAdminDuration('500ms')).toBe(500);
  });

  it('非法值回落 15 分钟', () => {
    expect(parseAdminDuration('abc')).toBe(15 * 60000);
    expect(parseAdminDuration('')).toBe(15 * 60000);
  });
});

/** 测试环境下 ADMIN_JWT_SECRET 未配置 → 由 JWT_SECRET 派生（与 admin-jwt.ts 一致） */
function adminSecretForTest(): string {
  return `${process.env.JWT_SECRET}:admin-console`;
}

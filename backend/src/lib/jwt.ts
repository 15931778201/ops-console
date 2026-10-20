/**
 * JWT 工具
 * - Access Token：短时效（默认 15m），payload { sub, sid, plan }
 * - Refresh Token：不使用 JWT，使用 256-bit 随机串（见 session.service.ts）
 */

import jwt from 'jsonwebtoken';
import { config } from './config';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  plan: string;
}

function accessSecret(): string {
  return config.JWT_SECRET;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, accessSecret(), {
    expiresIn: config.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, accessSecret()) as AccessTokenPayload;
    if (typeof decoded.sub !== 'string' || typeof decoded.sid !== 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}

/** 生成 256-bit 随机刷新令牌（URL 安全） */
export function generateRefreshToken(): string {
  return jwt.sign(
    { r: Math.random().toString(36), t: Date.now() },
    // 仅用于构造随机串，不使用其可验证性
    config.JWT_SECRET + ':refresh-entropy'
  ).replace(/[^a-zA-Z0-9]/g, '') + Math.random().toString(36).slice(2);
}

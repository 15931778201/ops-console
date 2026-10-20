/**
 * TOTP（RFC 6238）与恢复码
 * - 30 秒步长，6 位码，校验窗口 ±1（容忍时钟偏移）
 * - secret：160-bit 随机，Base32（RFC 4648）编码，落库前由 field-cipher 加密
 * - 恢复码：10 个一次性码，仅存 sha256 hash，用后即焚
 * 实现不依赖外部库（otplib 等），便于审计与零供应链风险。
 */

import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
const VERIFY_WINDOW = 1; // ±1 步长
const SECRET_BYTES = 20; // 160-bit（RFC 4226 推荐）
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;
// 去除易混淆字符（0/O/1/I/L）
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---------- Base32（RFC 4648） ----------

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('base32: 非法字符');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- HOTP / TOTP（RFC 4226 / 6238） ----------

/** HOTP：HMAC-SHA1 动态截断 */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.max(counter, 0)));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * TOTP：按时间步长计数。
 * secret 入参为 Base32 字符串（与 generateTotpSecret / verifyTotp / buildOtpauthUrl 保持一致的
 * 公开 API 面；底层 hotp 仍接收解码后的 Buffer）。
 */
export function totp(secretBase32: string, atMs: number = Date.now(), digits = DIGITS): string {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  return hotp(secret, counter, digits);
}

/** 生成 160-bit 随机 secret（Base32，可直接嵌入 otpauth URL） */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** 构造 otpauth:// URL（authenticator App 扫码用） */
export function buildOtpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 恒定时间比较，防时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 校验 TOTP 码（±1 窗口）。
 * 注意：不做"已用码"去重——如需防重放，调用方应结合短期 Redis 记录
 * （同一 counter 只允许成功一次）。管理后台登录限流已覆盖暴力尝试面。
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number = Date.now(),
  window = VERIFY_WINDOW
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  if (secret.length === 0) return false;
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (let i = -window; i <= window; i += 1) {
    const expected = hotp(secret, counter + i, DIGITS);
    if (safeEqual(expected, code)) return true;
  }
  return false;
}

// ---------- 恢复码 ----------

/** 生成一次性恢复码（明文仅此时返回一次） */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j += 1) {
      code += RECOVERY_ALPHABET[randomBytes(1)[0]! % RECOVERY_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

/** 恢复码 hash（与 TOTP secret 一样，只存 hash） */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/**
 * 在已存 hash 列表中查找恢复码；命中返回其下标（调用方据此"用后即焚"）。
 * 全部比较耗时近似恒定（遍历全表），避免通过响应时间探测有效码位置。
 */
export function matchRecoveryCode(storedHashes: string[], code: string): number {
  const target = hashRecoveryCode(code);
  let found = -1;
  for (let i = 0; i < storedHashes.length; i += 1) {
    const candidate = Buffer.from(storedHashes[i]!, 'hex');
    const targetBuf = Buffer.from(target, 'hex');
    if (candidate.length === targetBuf.length && timingSafeEqual(candidate, targetBuf)) {
      found = i; // 继续遍历完，避免短回路时序差异
    }
  }
  return found;
}

import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  base32Decode,
  hotp,
  totp,
  generateTotpSecret,
  buildOtpauthUrl,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchRecoveryCode,
} from './totp';

/**
 * RFC 6238 官方测试向量
 * secret = ASCII "12345678901234567890"（Base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ）
 * 步长 30s，SHA1，8 位码。
 */
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS: Array<[seconds: number, code8: string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('base32', () => {
  it('编解码往返一致', () => {
    for (const len of [1, 5, 10, 20, 32]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });

  it('RFC 4648 已知向量', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
  });

  it('拒绝非法字符', () => {
    expect(() => base32Decode('MZXW6YT1!O')).toThrow();
  });
});

describe('HOTP（RFC 4226 向量）', () => {
  it('counter 0..9 与官方向量一致', () => {
    const secret = base32Decode(RFC_SECRET_BASE32);
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => {
      expect(hotp(secret, counter)).toBe(code);
    });
  });
});

describe('TOTP（RFC 6238 向量）', () => {
  it.each(RFC_VECTORS)('T=%i → %s', (seconds, code8) => {
    const secret = base32Decode(RFC_SECRET_BASE32);
    expect(hotp(secret, Math.floor(seconds / 30), 8)).toBe(code8);
  });

  it('6 位码为 8 位码的截断（末 6 位）', () => {
    // T=59 → 8 位 94287082 → 6 位 287082
    expect(totp(RFC_SECRET_BASE32, 59 * 1000)).toBe('287082');
    // T=1111111109 → 8 位 07081804 → 6 位 081804
    expect(totp(RFC_SECRET_BASE32, 1111111109 * 1000)).toBe('081804');
  });

  it('按时间推进每 30 秒换码', () => {
    // 对齐到 30 秒步长边界，保证窗口内不跨步
    const base = Math.floor(Date.now() / 30_000) * 30_000;
    const c1 = totp(RFC_SECRET_BASE32, base);
    const c2 = totp(RFC_SECRET_BASE32, base + 30_000);
    expect(c1).not.toBe(c2);
    // 同一步长内（+29s）不变
    expect(totp(RFC_SECRET_BASE32, base + 29_000)).toBe(c1);
  });
});

describe('generateTotpSecret / buildOtpauthUrl', () => {
  it('生成 160-bit Base32 secret（32 字符）', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret).length).toBe(20);
  });

  it('每次生成不同', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it('otpauth URL 含 issuer/secret/period/digits', () => {
    const url = buildOtpauthUrl('SECRET123', 'alice', '合羽PDF运营后台');
    expect(url.startsWith('otpauth://totp/')).toBe(true);
    expect(url).toContain('secret=SECRET123');
    expect(url).toContain('period=30');
    expect(url).toContain('digits=6');
    expect(url).toContain('algorithm=SHA1');
    // issuer 在 label 与参数中各出现一次
    expect(decodeURIComponent(url)).toContain('合羽PDF运营后台:alice');
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  // 固定并对齐时间戳：避免采集期与执行期之间跨过 30s 边界导致偶发失败
  const now = Math.floor(Date.now() / 30_000) * 30_000;

  it('接受当前窗口的码', () => {
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
  });

  it('接受 ±1 窗口（容忍时钟偏移）', () => {
    const prev = totp(secret, now - 30_000);
    const next = totp(secret, now + 30_000);
    expect(verifyTotp(secret, prev, now)).toBe(true);
    expect(verifyTotp(secret, next, now)).toBe(true);
  });

  it('拒绝超出窗口的旧码', () => {
    const stale = totp(secret, now - 90_000);
    expect(verifyTotp(secret, stale, now)).toBe(false);
  });

  it('拒绝错误码与格式非法输入', () => {
    // 选一个必然错误的码（避开真实码，防巧合）
    const actual = totp(secret, now);
    const wrong = actual === '000000' ? '000001' : '000000';
    expect(verifyTotp(secret, wrong, now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
    expect(verifyTotp('!!!not-base32!!!', '123456', now)).toBe(false);
    expect(verifyTotp('', '123456', now)).toBe(false);
  });
});

describe('恢复码', () => {
  it('生成 10 个 10 位码（去混淆字符集）', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{10}$/);
    }
    expect(new Set(codes).size).toBe(10);
  });

  it('hash 不泄露明文，匹配返回下标', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    expect(hashes[0]).not.toContain(codes[0]!);
    expect(matchRecoveryCode(hashes, codes[3]!)).toBe(3);
    expect(matchRecoveryCode(hashes, codes[9]!)).toBe(9);
  });

  it('大小写/空白不敏感', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    expect(matchRecoveryCode(hashes, ` ${codes[0]!.toLowerCase()} `)).toBe(0);
  });

  it('未命中返回 -1', () => {
    const hashes = generateRecoveryCodes().map(hashRecoveryCode);
    expect(matchRecoveryCode(hashes, 'AAAAAAAAAA')).toBe(-1);
    expect(matchRecoveryCode([], 'AAAAAAAAAA')).toBe(-1);
  });

  it('用后即焚：移除后不再匹配', () => {
    const codes = generateRecoveryCodes();
    let hashes = codes.map(hashRecoveryCode);
    const idx = matchRecoveryCode(hashes, codes[2]!);
    hashes = hashes.filter((_, i) => i !== idx);
    expect(matchRecoveryCode(hashes, codes[2]!)).toBe(-1);
  });
});

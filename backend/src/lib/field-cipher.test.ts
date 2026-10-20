import { describe, expect, it } from 'vitest';
import { encryptField, decryptField, isEncryptedField } from './field-cipher';

describe('field-cipher（AES-256-GCM）', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP'; // 典型 TOTP secret

  it('加解密往返一致', () => {
    const encoded = encryptField(SECRET);
    expect(decryptField(encoded)).toBe(SECRET);
  });

  it('密文不包含明文（防拖库直接读取）', () => {
    const encoded = encryptField(SECRET);
    expect(encoded).not.toContain(SECRET);
    expect(encoded.startsWith('v1:')).toBe(true);
    expect(encoded.split(':')).toHaveLength(4);
    expect(isEncryptedField(encoded)).toBe(true);
  });

  it('同一明文两次加密结果不同（随机 IV）', () => {
    expect(encryptField(SECRET)).not.toBe(encryptField(SECRET));
  });

  it('密文被篡改时解密抛出（认证加密）', () => {
    const encoded = encryptField(SECRET);
    const [prefix, iv, tag, ct] = encoded.split(':') as [string, string, string, string];
    // 翻转密文中间一个字节后重新编码（base64 末位字符可能只承载填充位，直接改字符不可靠）
    const ctBuf = Buffer.from(ct, 'base64');
    ctBuf[Math.floor(ctBuf.length / 2)] = ctBuf[Math.floor(ctBuf.length / 2)]! ^ 0xff;
    const tampered = [prefix, iv, tag, ctBuf.toString('base64')].join(':');
    expect(() => decryptField(tampered)).toThrow();
  });

  it('认证标签被篡改时解密抛出', () => {
    const encoded = encryptField(SECRET);
    const [prefix, iv, tag, ct] = encoded.split(':') as [string, string, string, string];
    const tagBuf = Buffer.from(tag, 'base64');
    tagBuf[0] = tagBuf[0]! ^ 0xff;
    const tampered = [prefix, iv, tagBuf.toString('base64'), ct].join(':');
    expect(() => decryptField(tampered)).toThrow();
  });

  it('IV 被替换时解密抛出', () => {
    const encoded = encryptField(SECRET);
    const parts = encoded.split(':');
    const iv = Buffer.from(parts[1]!, 'base64');
    iv[0] = iv[0]! ^ 0xff;
    const tampered = [parts[0], iv.toString('base64'), parts[2], parts[3]].join(':');
    expect(() => decryptField(tampered)).toThrow();
  });

  it('格式非法的输入被拒绝', () => {
    expect(() => decryptField('not-a-ciphertext')).toThrow();
    expect(() => decryptField('v2:aaaa:bbbb:cccc')).toThrow();
    expect(() => decryptField('v1:short:tag:ct')).toThrow();
    expect(isEncryptedField('plaintext')).toBe(false);
    expect(isEncryptedField('v1:a:b')).toBe(false);
  });

  it('支持中文等 UTF-8 明文', () => {
    const text = '运维负责人-张伟';
    expect(decryptField(encryptField(text))).toBe(text);
  });
});

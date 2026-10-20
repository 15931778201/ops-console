/**
 * 字段级加密（AES-256-GCM）
 * 用途：TOTP secret 等敏感字段落库前加密（schema 约定密钥由 JWT_SECRET 派生）。
 * 格式：v1:<iv_b64>:<tag_b64>:<ct_b64>（版本前缀便于未来轮换算法/密钥）
 * 特性：认证加密——密文或认证标签被篡改时解密抛出（拒绝提供伪造明文）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { config } from './config';

const PREFIX = 'v1';
const IV_LENGTH = 12; // GCM 推荐 96-bit nonce
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

/** 派生 256-bit 密钥（域分离盐固定，轮换密钥需 bump 版本前缀并迁移数据） */
function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = createHash('sha256')
    .update(`field-cipher:${PREFIX}:${config.JWT_SECRET}`)
    .digest();
  return cachedKey;
}

/** 加密为自描述字符串 */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * 解密；格式错误或认证失败（篡改）时抛出 Error。
 * 调用方决定降级行为（认证流程中应将异常转为"服务器配置错误"而非放行）。
 */
export function decryptField(encoded: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('field-cipher: 密文格式无效');
  }
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const ct = Buffer.from(parts[3]!, 'base64');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('field-cipher: iv/tag 长度非法');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** 判断是否为当前版本可解密的密文（不执行解密） */
export function isEncryptedField(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === PREFIX;
}

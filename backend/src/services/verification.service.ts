/**
 * 验证码服务
 * - 6 位数字验证码，5 分钟有效，hash 存储
 * - 发送限频：同目标 60 秒 1 条、每小时 5 条（限流中间件 + DB 双查）
 * - 校验：错误次数上限 5，消耗后置 consumedAt；统一错误文案防枚举
 */

import { createHash, randomInt } from 'node:crypto';
import type { VerificationChannel as Channel, VerificationType } from '@prisma/client';
import prisma from '../lib/prisma';
import { getVerificationAdapter } from '../lib/verification-channel';
import { AuthError, ErrorCode } from '../lib/errors';
import { logger } from '../lib/logger';

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;
const HOURLY_LIMIT = 5;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function generateCode(): string {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

export const verificationService = {
  /**
   * 发送验证码
   * channel 由服务端根据 target 类型推断（email/sms），与 config 的启用渠道比对
   */
  async send(
    target: string,
    type: VerificationType,
    channel: Channel,
    requestId?: string
  ): Promise<void> {
    const now = new Date();

    // 冷却：60 秒内不允许重发
    const recent = await prisma.verificationCode.findFirst({
      where: { target, type, createdAt: { gt: new Date(now.getTime() - RESEND_COOLDOWN_SEC * 1000) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (recent) {
      throw new AuthError(
        ErrorCode.VERIFICATION_TOO_FREQUENT,
        '验证码发送过于频繁，请稍后再试'
      );
    }

    // 每小时上限
    const hourly = await prisma.verificationCode.count({
      where: {
        target,
        type,
        createdAt: { gt: new Date(now.getTime() - 3600 * 1000) },
      },
    });
    if (hourly >= HOURLY_LIMIT) {
      throw new AuthError(
        ErrorCode.VERIFICATION_TOO_FREQUENT,
        '验证码发送次数已达上限，请稍后再试'
      );
    }

    const code = generateCode();
    await prisma.verificationCode.create({
      data: {
        target,
        channel,
        type,
        codeHash: hashCode(code),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      },
    });

    try {
      await getVerificationAdapter().send(target, code);
      logger.info({ target, type, requestId }, 'verification_code_sent');
    } catch (err) {
      // 发送失败不阻断响应细节，返回统一错误
      logger.error({ err, target, type }, 'verification_send_failed');
      throw new AuthError(
        ErrorCode.VERIFICATION_TOO_FREQUENT,
        '验证码发送失败，请稍后重试或更换方式'
      );
    }
  },

  /** 校验并消耗验证码 */
  async verify(
    target: string,
    code: string,
    type: VerificationType
  ): Promise<void> {
    const record = await prisma.verificationCode.findFirst({
      where: { target, type, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.expiresAt < new Date()) {
      throw new AuthError(ErrorCode.VERIFICATION_CODE_EXPIRED, '验证码已过期，请重新获取');
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new AuthError(
        ErrorCode.VERIFICATION_CODE_INVALID,
        '验证码错误次数过多，请重新获取'
      );
    }
    if (record.codeHash !== hashCode(code)) {
      await prisma.verificationCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new AuthError(ErrorCode.VERIFICATION_CODE_INVALID, '验证码错误');
    }

    await prisma.verificationCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
  },

  /** 校验并消耗（不抛错版本，供注册流程内联使用） */
  async verifySilently(
    target: string,
    code: string,
    type: VerificationType
  ): Promise<boolean> {
    try {
      await this.verify(target, code, type);
      return true;
    } catch {
      return false;
    }
  },
};

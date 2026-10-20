/**
 * 审计日志（追加式）
 * 记录登录成功/失败、令牌吊销、调账、退款、管理员操作等安全相关事件。
 * 禁止记录密码、令牌、验证码、PDF 相关数据（详见 logger 脱敏清单）。
 */

import prisma from './prisma';
import { logger } from './logger';
import type { AuditActorType } from '@prisma/client';

export interface AuditInput {
  actorType?: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export const audit = {
  /** 记录一条审计事件（失败不影响主流程） */
  async record(input: AuditInput): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          actorType: input.actorType ?? 'USER',
          actorId: input.actorId ?? null,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          metadata: input.metadata as object | undefined,
          requestId: input.requestId,
        },
      });
    } catch (err) {
      logger.error({ err, action: input.action }, 'audit_record_failed');
    }
  },
};

/**
 * 统一响应 envelope
 * 成功：{ success: true, data }
 * 失败：{ success: false, error: { code, message, details? } }
 */

import type { Response } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode, isAppError } from './errors';
import { logger } from './logger';

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function sendSuccess<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ success: true, data });
}

export function sendPaginated<T>(
  res: Response,
  items: T[],
  pagination: Pagination,
  /** 附加汇总字段（如金额合计、状态分组计数），与 items/pagination 同级 */
  extra?: Record<string, unknown>
): void {
  res.status(200).json({
    success: true,
    data: { items, ...(extra ?? {}), pagination },
  });
}

/** 错误出口：AppError 按契约输出；Zod 校验失败归一为 400 VALIDATION_FAILED；未知错误脱敏 500 */
export function sendError(res: Response, error: unknown, context?: string): void {
  // Zod 校验失败：统一 400 + 字段级 details（契约：VALIDATION_FAILED）
  if (error instanceof z.ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    res.status(400).json({
      success: false,
      error: { code: ErrorCode.VALIDATION_FAILED, message: '参数验证失败', details },
    });
    return;
  }

  if (isAppError(error)) {
    const body: {
      success: false;
      error: { code: string; message: string; details?: unknown };
    } = {
      success: false,
      error: { code: error.code, message: error.message },
    };
    if (error.details !== undefined) body.error.details = error.details;
    res.status(error.statusCode).json(body);
    return;
  }

  // 未知错误：不向客户端泄露内部细节
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(
    { err, context },
    'unhandled error'
  );
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
  });
}

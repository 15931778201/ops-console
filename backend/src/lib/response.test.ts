import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { z } from 'zod';
import { sendSuccess, sendPaginated, sendError } from './response';
import { AppError, AuthError, ErrorCode, isAppError } from './errors';

function mockRes(): Response {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response;
}

describe('统一 envelope', () => {
  it('成功响应包装 {success:true,data}', () => {
    const res = mockRes();
    sendSuccess(res, { id: 'u1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: 'u1' } });
  });

  it('成功响应支持自定义状态码', () => {
    const res = mockRes();
    sendSuccess(res, { ok: true }, 201);
    expect(res.statusCode).toBe(201);
  });

  it('分页响应包装 items+pagination', () => {
    const res = mockRes();
    sendPaginated(res, [1, 2], { page: 1, pageSize: 20, total: 2, totalPages: 1 });
    expect(res.body).toEqual({
      success: true,
      data: { items: [1, 2], pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 } },
    });
  });

  it('AppError 按契约输出 code/message', () => {
    const res = mockRes();
    sendError(res, new AuthError(ErrorCode.INVALID_CREDENTIALS, '账号或密码错误'));
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: '账号或密码错误' },
    });
  });

  it('未知错误脱敏为 500', () => {
    const res = mockRes();
    sendError(res, new Error('数据库连接串 postgres://user:pass@host'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
    });
  });

  it('Zod 校验失败归一为 400 VALIDATION_FAILED + 字段级 details', () => {
    const schema = z.object({ email: z.string().email(), age: z.coerce.number().int().positive() });
    const result = schema.safeParse({ email: 'not-an-email', age: -1 });
    expect(result.success).toBe(false);
    const res = mockRes();
    sendError(res, result.error);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: '参数验证失败',
        details: expect.arrayContaining([
          expect.objectContaining({ path: 'email' }),
          expect.objectContaining({ path: 'age' }),
        ]),
      },
    });
  });
});

describe('错误类型', () => {
  it('AuthError 统一 401', () => {
    const err = new AuthError(ErrorCode.TOKEN_EXPIRED, 'x');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('TOKEN_EXPIRED');
    expect(isAppError(err)).toBe(true);
  });

  it('AppError 可携带 details', () => {
    const err = new AppError(400, 'VALIDATION_FAILED', 'bad', { field: 'email' });
    expect(err.details).toEqual({ field: 'email' });
  });
});

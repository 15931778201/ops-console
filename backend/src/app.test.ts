/**
 * 应用级回归测试
 * 关键场景：路由挂载顺序——/api/admin/v1 必须先于 /api/admin，
 * 否则 express.use 的前缀匹配会令旧通道吞掉新体系全部请求（曾真实发生）。
 * 同时锁定 Zod 校验失败归一 400 VALIDATION_FAILED 的契约。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import app from './index';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('路由挂载顺序（回归）', () => {
  it('/api/admin/v1/auth/login 到达新体系：缺参 → 400 VALIDATION_FAILED', async () => {
    const res = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'password' }), // 缺 username/password
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(json.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(json.error.details)).toBe(true);
  });

  it('/api/admin/v1/auth/login 允许运营后台开发来源，不因 CORS 变成 500', async () => {
    const res = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:1430',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ step: 'password' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1430');
  });

  it('/api/admin/v1/auth/login 拒绝未授权来源时返回 403，而不是 500', async () => {
    const res = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: {
        Origin: 'http://not-allowed.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ step: 'password' }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('/api/admin/v1/admins 未登录 → 401 ADMIN_INVALID_CREDENTIALS（新体系错误码）', async () => {
    const res = await fetch(`${baseUrl}/api/admin/v1/admins`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('ADMIN_INVALID_CREDENTIALS');
  });

  it('/api/admin/users 未登录 → 401 UNAUTHORIZED（旧 break-glass 通道仍工作）', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('UNAUTHORIZED');
  });

  it('用户端路由不受挂载调整影响：POST /api/auth/login 缺参 → 400', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('未知路径 → 404', async () => {
    const res = await fetch(`${baseUrl}/api/no-such-route`);
    expect(res.status).toBe(404);
  });

  it('/api/admin/v1 下的未知子路径未认证 → 401（admin 体系错误码，不泄漏路由存在性）', async () => {
    // 兜底 404 处理器声明在 adminAuthMiddleware 之后，故未认证请求先被拦下。
    // 回归点：此处曾返回旧通道的 401 UNAUTHORIZED（穿透到 /api/admin），
    // 现在必须是 admin 体系的 401 ADMIN_INVALID_CREDENTIALS。
    // 已认证时的 404 行为由 tests-e2e/http.e2e.ts 用真实令牌覆盖。
    const res = await fetch(`${baseUrl}/api/admin/v1/no-such-module`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { success: boolean; error: { code: string } };
    expect(json.success).toBe(false);
    expect(json.error.code).toBe('ADMIN_INVALID_CREDENTIALS');
  });
});

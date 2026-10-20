/**
 * API 客户端单测
 * 关注四个容易出错的不变量：
 *  1. envelope 解包正确，成功返回 data、失败抛 ApiError
 *  2. 401 只触发一次刷新并重放原请求（并发 401 单飞）
 *  3. 刷新失败 → 清会话 + 通知上层跳登录，绝不无限重试
 *  4. 令牌只存内存 + sessionStorage（access 刷新页面即失效）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  clearTokens,
  getAccessToken,
  hasSession,
  setSessionLostHandler,
  setTokens,
} from '../lib/api-client';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let calls: Call[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }));
}

beforeEach(() => {
  sessionStorage.clear();
  clearTokens();
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSessionLostHandler(null);
});

describe('envelope 解包', () => {
  it('成功响应返回 data', async () => {
    mockFetch(() => jsonResponse(200, { success: true, data: { id: 'a1' } }));
    const r = await api.get<{ id: string }>('/admins/1');
    expect(r.id).toBe('a1');
  });

  it('失败响应抛 ApiError并带 code/message', async () => {
    mockFetch(() =>
      jsonResponse(400, {
        success: false,
        error: { code: 'VALIDATION_FAILED', message: '参数不合法', details: [{ path: 'page', message: '太小' }] },
      })
    );
    await expect(api.get('/orders')).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: '参数不合法',
    });
  });

  it('fieldErrors 把details 归一为字段映射', () => {
    const e = new ApiError(400, 'VALIDATION_FAILED', 'x', [
      { path: 'username', message: '必填' },
      { path: 'password', message: '太弱' },
    ]);
    expect(e.fieldErrors()).toEqual({ username: '必填', password: '太弱' });
  });

  it('无 details 时 fieldErrors 返回空对象', () => {
    expect(new ApiError(403, 'ADMIN_PERMISSION_DENIED', '权限不足').fieldErrors()).toEqual({});
  });

  it('403/401 便捷判定正确', () => {
    expect(new ApiError(403, 'X', 'x').isForbidden).toBe(true);
    expect(new ApiError(401, 'X', 'x').isUnauthorized).toBe(true);
    expect(new ApiError(500, 'X', 'x').isForbidden).toBe(false);
  });

  it('非 JSON 响应兜底为 UNKNOWN_ERROR', async () => {
    mockFetch(() => new Response('<html>502</html>', { status: 502 }));
    await expect(api.get('/orders')).rejects.toMatchObject({ status: 502, code: 'UNKNOWN_ERROR' });
  });
});

describe('令牌处理', () => {
  it('setTokens 写内存 + sessionStorage，getAccessToken 可读', () => {
    setTokens('access-1', 'refresh-1');
    expect(getAccessToken()).toBe('access-1');
    expect(sessionStorage.getItem('heyu_admin_refresh')).toBe('refresh-1');
    expect(hasSession()).toBe(true);
  });

  it('clearTokens 清空全部', () => {
    setTokens('a', 'r');
    clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(hasSession()).toBe(false);
    expect(sessionStorage.getItem('heyu_admin_refresh')).toBeNull();
  });

  it('请求自动带上 Authorization 头', async () => {
    setTokens('access-1', 'refresh-1');
    mockFetch(() => jsonResponse(200, { success: true, data: {} }));
    await api.get('/auth/me');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
  });

  it('无令牌时不带 Authorization 头', async () => {
    mockFetch(() => jsonResponse(401, { success: false, error: { code: 'X', message: 'x' } }));
    await api.get('/auth/me').catch(() => undefined);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('401 刷新与重放', () => {
  it('401 → 刷新成功 → 用新令牌重放原请求', async () => {
    setTokens('old-access', 'refresh-1');
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(200, {
          success: true,
          data: { accessToken: 'new-access', refreshToken: 'refresh-2', expiresIn: 900 },
        });
      }
      if (calls.filter((c) => !c.url.endsWith('/auth/refresh')).length === 1) {
        return jsonResponse(401, { success: false, error: { code: 'ADMIN_INVALID_CREDENTIALS', message: '未登录' } });
      }
      return jsonResponse(200, { success: true, data: { ok: true } });
    });

    const r = await api.get<{ ok: boolean }>('/auth/me');
    expect(r.ok).toBe(true);
    expect(getAccessToken()).toBe('new-access');
    expect(sessionStorage.getItem('heyu_admin_refresh')).toBe('refresh-2');
    // 原请求被重放了一次（两次 /auth/me）
    expect(calls.filter((c) => c.url.endsWith('/auth/me')).length).toBe(2);
  });

  it('重放后的请求带新令牌', async () => {
    setTokens('old-access', 'refresh-1');
    let businessCalls = 0;
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(200, {
          success: true,
          data: { accessToken: 'new-access', refreshToken: 'refresh-2', expiresIn: 900 },
        });
      }
      businessCalls += 1;
      return businessCalls === 1
        ? jsonResponse(401, { success: false, error: { code: 'X', message: 'x' } })
        : jsonResponse(200, { success: true, data: {} });
    });
    await api.get('/auth/me');
    const meCalls = calls.filter((c) => c.url.endsWith('/auth/me'));
    expect(meCalls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer old-access' });
    expect(meCalls[1]!.init?.headers).toMatchObject({ Authorization: 'Bearer new-access' });
  });

  it('刷新失败 → 清会话 + 通知跳登录，且不重试', async () => {
    setTokens('old-access', 'bad-refresh');
    let lost = 0;
    setSessionLostHandler(() => {
      lost += 1;
    });
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(401, { success: false, error: { code: 'X', message: '刷新失败' } });
      }
      return jsonResponse(401, { success: false, error: { code: 'ADMIN_INVALID_CREDENTIALS', message: '未登录' } });
    });

    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(lost).toBe(1);
    expect(hasSession()).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('/auth/me')).length).toBe(1);
  });

  it('无 refresh token 时不发起刷新请求', async () => {
    setTokens('old-access', null);
    mockFetch(() => jsonResponse(401, { success: false, error: { code: 'X', message: 'x' } }));
    await api.get('/auth/me').catch(() => undefined);
    expect(calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(false);
  });

  it('刷新接口网络异常也判定为失败', async () => {
    setTokens('old-access', 'refresh-1');
    setSessionLostHandler(() => undefined);
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) throw new Error('network down');
      return jsonResponse(401, { success: false, error: { code: 'X', message: 'x' } });
    });
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
  });

  it('回归：早退（无 refresh token）后单飞锁必须释放，后续刷新仍可成功', async () => {
    // 曾经的 bug：refreshing 在「无 refresh token」早退分支不经 finally 释放，
    // 永久卡在已 resolve 的 false 上 —— 之后再登录也无法刷新，只能刷新页面。
    setTokens('old-access', null);
    setSessionLostHandler(() => undefined);
    mockFetch(() => jsonResponse(401, { success: false, error: { code: 'X', message: 'x' } }));
    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });

    // 现在带上 refresh token 再来一次，应能正常刷新并重放
    setTokens('old-access', 'refresh-1');
    let businessCalls = 0;
    mockFetch((url) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(200, {
          success: true,
          data: { accessToken: 'fresh-access', refreshToken: 'refresh-2', expiresIn: 900 },
        });
      }
      businessCalls += 1;
      return businessCalls === 1
        ? jsonResponse(401, { success: false, error: { code: 'X', message: 'x' } })
        : jsonResponse(200, { success: true, data: { ok: true } });
    });
    const r = await api.get<{ ok: boolean }>('/auth/me');
    expect(r.ok).toBe(true);
    expect(getAccessToken()).toBe('fresh-access');
  });
});

describe('query拼装', () => {
  it('跳过 undefined/null/空串，保留 0 与 false', async () => {
    mockFetch(() => jsonResponse(200, { success: true, data: {} }));
    await api.get('/orders', {
      page: 1,
      pageSize: 20,
      orderNo: '',
      status: undefined,
      channel: null,
      pendingOnly: false,
    });
    const url = new URL(calls[0]!.url, 'http://x');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('pageSize')).toBe('20');
    expect(url.searchParams.has('orderNo')).toBe(false);
    expect(url.searchParams.has('status')).toBe(false);
    expect(url.searchParams.has('channel')).toBe(false);
    expect(url.searchParams.get('pendingOnly')).toBe('false');
  });

  it('无 query 时 URL 不带问号', async () => {
    mockFetch(() => jsonResponse(200, { success: true, data: {} }));
    await api.get('/admins');
    expect(calls[0]!.url).not.toContain('?');
  });
});

describe('方法与body', () => {
  it('post 发送 JSON body', async () => {
    mockFetch(() => jsonResponse(200, { success: true, data: {} }));
    await api.post('/users/1/status', { status: 'SUSPENDED', reason: '测试' });
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      status: 'SUSPENDED',
      reason: '测试',
    });
  });

  it('get 不发送 body', async () => {
    mockFetch(() => jsonResponse(200, { success: true, data: {} }));
    await api.get('/admins');
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it('del 使用 DELETE', async () => {
    mockFetch(() => jsonResponse(200, { success: true, data: {} }));
    await api.del('/auth/sessions/s1');
    expect(calls[0]!.init?.method).toBe('DELETE');
  });

  it('put 使用 PUT', async () => {
    mockFetch(() => jsonResponse(200, { success: true, data: {} }));
    await api.put('/admins/a1', { role: 'AUDITOR' });
    expect(calls[0]!.init?.method).toBe('PUT');
  });
});
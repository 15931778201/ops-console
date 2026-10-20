/**
 * 运营后台 API 客户端
 *
 * 与用户端 `src/lib/api/client.ts` 同构但**独立**：
 * - admin access token 只存内存（模块级变量），不落 sessionStorage/localStorage
 * - refresh token 存 sessionStorage（关闭标签页即失效）
 * - 401 自动刷新并重放原请求；并发 401 只触发一次刷新（其余请求排队等同一Promise）
 * - 统一 envelope：成功 {success,data}；失败 {success:false,error:{code,message,details}}
 *
 * 安全约定（设计文档 7.3）：
 * - access token 不进 URL、不进日志、不进错误信息
 * - 刷新失败即清空会话并跳登录，绝不无限重试
 */

/** 后端基址：留空则用同源 /api（开发期由 vite proxy 转发） */
export const API_BASE = (import.meta.env?.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

/** 纯前端 Mock：默认开启，VITE_API_MOCK=false 才走真实后端 */
export const API_MOCK = (import.meta.env?.VITE_API_MOCK as string | undefined) !== 'false';

const ACCESS_KEY = 'heyu_admin_access';
const REFRESH_KEY = 'heyu_admin_refresh';

/** access token 仅存内存：刷新页面即失效，需重新走两步登录 */
let accessToken: string | null = sessionStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = sessionStorage.getItem(REFRESH_KEY);
let onSessionLost: (() => void) | null = null;

/** 并发 401 时的单飞刷新 */
let refreshing: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 权限不足 */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** 字段级校验错误（后端 Zod 归一后的 details） */
  fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const d of this.details as Array<{ path?: string; message?: string }>) {
      const key = d.path ?? '';
      if (key && !out[key]) out[key] = d.message ?? '无效';
    }
    return out;
  }
}

export function setTokens(access: string | null, refresh: string | null): void {
  accessToken = access;
  refreshToken = refresh;
  if (access) sessionStorage.setItem(ACCESS_KEY, access);
  else sessionStorage.removeItem(ACCESS_KEY);
  if (refresh) sessionStorage.setItem(REFRESH_KEY, refresh);
  else sessionStorage.removeItem(REFRESH_KEY);
}

export function clearTokens(): void {
  setTokens(null, null);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function hasSession(): boolean {
  return Boolean(accessToken);
}

/** 注册会话失效回调（由 AuthProvider 注入，用于跳登录） */
export function setSessionLostHandler(fn: (() => void) | null): void {
  onSessionLost = fn;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

async function parse<T>(res: Response): Promise<T> {
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = null;
  }

  if (!res.ok || !body?.success) {
    const err = body?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN_ERROR',
      err?.message ?? `请求失败（HTTP ${res.status}）`,
      err?.details
    );
  }
  return body.data as T;
}

/**
 * 刷新令牌（单飞）。
 *
 * 实现要点：`refreshing` 必须在 promise **创建前**占位，且由promise 自身负责释放。
 * 若写成 `refreshing = (async () => { ... finally { refreshing = null } })()`，
 * IIFE 会同步执行到第一个 await——此时 finally 可能在赋值生效前就把 refreshing 置空，
 * 造成"锁看起来没上"的竞态。故改为显式 new Promise + .finally 链。
 */
async function refreshTokens(): Promise<boolean> {
  if (refreshing) return refreshing;

  const rt = refreshToken;
  const run = async (): Promise<boolean> => {
    if (!rt) return false;
    try {
      const res = await fetch(`${API_BASE}/api/admin/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      const body = (await res.json().catch(() => null)) as Envelope<{
        accessToken: string;
        refreshToken: string;
      }> | null;
      if (!res.ok || !body?.success || !body.data?.accessToken) return false;
      setTokens(body.data.accessToken, body.data.refreshToken);
      return true;
    } catch {
      return false;
    }
  };

  // 先占位再执行，保证并发调用一定命中同一把锁
  const p = run().finally(() => {
    if (refreshing === p) refreshing = null;
  });
  refreshing = p;
  return p;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** 内部使用：标记已重试过，避免无限刷新 */
  _retried?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}/api/admin/v1${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** 核心请求：带令牌、401 自动刷新重放一次、错误统一为 ApiError */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (API_MOCK) {
    const { mockRequest } = await import('../mock/server');
    return (await mockRequest(options.method ?? 'GET', path, options.query, options.body)) as T;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  // 401：先试刷新（仅一次），成功则重放；失败则清会话并通知上层跳登录
  if (res.status === 401 && !options._retried) {
    const ok = await refreshTokens();
    if (ok) {
      return request<T>(path, { ...options, _retried: true });
    }
    clearTokens();
    onSessionLost?.();
  }

  return parse<T>(res);
}

/**
 * 文件下载请求：与 request 共用鉴权与 401 单飞刷新，但返回原始 Response
 * （导出接口返回文件流而非 JSON，不能走 parse）。
 */
export async function requestRaw(
  path: string,
  options: { method?: RequestOptions['method']; body?: unknown; _retried?: boolean } = {}
): Promise<Response> {
  if (API_MOCK) return new Response(new Blob(['mock']), { status: 200 });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(buildUrl(path), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  if (res.status === 401 && !options._retried) {
    const ok = await refreshTokens();
    if (ok) {
      return requestRaw(path, { ...options, _retried: true });
    }
    clearTokens();
    onSessionLost?.();
  }

  return res;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** 文件下载（导出等），返回原始 Response */
  raw: (path: string, body?: unknown) => requestRaw(path, { method: 'POST', body }),
};

// ---------- 类型 ----------

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: Pagination;
}

export type AdminRole = 'SUPER_ADMIN' | 'OPERATOR' | 'SUPPORT' | 'FINANCE' | 'AUDITOR';

export interface AdminView {
  id: string;
  username: string;
  name: string;
  role: AdminRole;
  status: 'ACTIVE' | 'DISABLED';
  totpEnabled: boolean;
  mustBindTotp: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
}

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AdminSessionView {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** 分页响应（后端统一 envelope 的 data 部分） */
export type Page<T> = Paginated<T>;
/**
 * 结构化日志（零依赖实现）
 * - JSON 行输出，字段：level/time/msg + 上下文字段
 * - 强制脱敏：密码、令牌、验证码、支付密钥、PDF 相关数据禁止落盘
 * - 请求上下文通过 AsyncLocalStorage 自动注入 requestId
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 敏感字段名（命中即整值替换为 [REDACTED]） */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'oldPassword',
  'accessToken',
  'refreshToken',
  'token',
  'authorization',
  'verificationCode',
  'code',
  'secret',
  'apiKey',
  'privateKey',
  'apiV3Key',
  'mchKey',
  'filename',
  'fileName',
  'filePath',
  'fileHash',
  'contentHash',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause !== undefined ? { cause: redact(value.cause, depth + 1) } : {}),
    };
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

interface LogRecord {
  level: LogLevel;
  time: string;
  msg: string;
  requestId?: string;
  [key: string]: unknown;
}

const asyncStorage = new AsyncLocalStorage<{ requestId: string }>();

/** 当前请求上下文（无请求时为 undefined） */
export function currentRequestId(): string | undefined {
  return asyncStorage.getStore()?.requestId;
}

/** 在请求上下文内执行（由 request-id 中间件调用） */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return asyncStorage.run({ requestId }, fn);
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const minLevel = (process.env.LOG_LEVEL as LogLevel) || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const record: LogRecord = {
    level,
    time: new Date().toISOString(),
    msg,
  };
  const requestId = currentRequestId();
  if (requestId) record.requestId = requestId;
  if (fields) Object.assign(record, redact(fields) as Record<string, unknown>);

  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** 子日志器：绑定固定上下文字段 */
export function child(bindings: Record<string, unknown>) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) =>
      write('debug', msg, { ...bindings, ...fields }),
    info: (msg: string, fields?: Record<string, unknown>) =>
      write('info', msg, { ...bindings, ...fields }),
    warn: (msg: string, fields?: Record<string, unknown>) =>
      write('warn', msg, { ...bindings, ...fields }),
    error: (msg: string, fields?: Record<string, unknown>) =>
      write('error', msg, { ...bindings, ...fields }),
  };
}

/** 支持两种调用风格：logger.info('msg', {fields}) 与 logger.info({fields}, 'msg') */
type LogArgs = [msg: string, fields?: Record<string, unknown>] | [fields: Record<string, unknown>, msg: string];

function normalizeArgs(args: LogArgs): { msg: string; fields?: Record<string, unknown> } {
  if (typeof args[0] === 'string') {
    return { msg: args[0], fields: args[1] as Record<string, unknown> | undefined };
  }
  return { msg: args[1] as string, fields: args[0] };
}

export const logger = {
  debug: (...args: LogArgs) => {
    const { msg, fields } = normalizeArgs(args);
    write('debug', msg, fields);
  },
  info: (...args: LogArgs) => {
    const { msg, fields } = normalizeArgs(args);
    write('info', msg, fields);
  },
  warn: (...args: LogArgs) => {
    const { msg, fields } = normalizeArgs(args);
    write('warn', msg, fields);
  },
  error: (...args: LogArgs) => {
    const { msg, fields } = normalizeArgs(args);
    write('error', msg, fields);
  },
  child,
};

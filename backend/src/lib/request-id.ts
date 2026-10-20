/**
 * 请求 ID 中间件：透传或生成 X-Request-Id，并建立日志上下文
 */

import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithRequestContext } from './logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const requestId =
    (Array.isArray(incoming) ? incoming[0] : incoming)?.slice(0, 128) || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  runWithRequestContext(requestId, next);
};

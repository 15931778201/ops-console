/**
 * async handler 包装：统一捕获路由异步错误，交给错误中间件
 */

import type { Request, RequestHandler, Response } from 'express';

export function asyncHandler(
  fn: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

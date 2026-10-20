/**
 * 认证中间件
 * - 解析 Bearer Access Token（payload: sub/sid/plan）
 * - 校验会话有效性（未吊销/未过期）与账号状态
 * - 错误统一 envelope + 错误码
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyAccessToken } from '../lib/jwt';
import prisma from '../lib/prisma';
import { sendError } from '../lib/response';
import { adminUserIds } from '../lib/config';
import { AuthError, ErrorCode } from '../lib/errors';
import { logger } from '../lib/logger';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    sessionId: string;
    email?: string | null;
    phone?: string | null;
    planId: string;
    isAdmin: boolean;
  };
}

export const authMiddleware: RequestHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthError(ErrorCode.UNAUTHORIZED, '未登录或登录已过期');
    }

    const payload = verifyAccessToken(authHeader.substring(7));
    if (!payload) {
      throw new AuthError(ErrorCode.TOKEN_EXPIRED, '登录已过期，请重新登录');
    }

    // 会话必须仍有效（支持服务端吊销/登出所有设备）
    const session = await prisma.session.findFirst({
      where: {
        id: payload.sid,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!session) {
      throw new AuthError(ErrorCode.UNAUTHORIZED, '登录状态已失效，请重新登录');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, phone: true, planId: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new AuthError(ErrorCode.ACCOUNT_DISABLED, '账号不存在或已被禁用');
    }

    req.user = {
      id: user.id,
      sessionId: session.id,
      email: user.email,
      phone: user.phone,
      planId: user.planId,
      isAdmin: adminUserIds().has(user.id),
    };
    next();
  } catch (error) {
    sendError(res, error, 'auth_middleware');
  }
};

/** 可选认证：携带有效令牌则注入 user，否则放行 */
export const optionalAuthMiddleware: RequestHandler = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const payload = verifyAccessToken(authHeader.substring(7));
      if (payload) {
        const session = await prisma.session.findFirst({
          where: {
            id: payload.sid,
            userId: payload.sub,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (session) {
          const user = await prisma.user.findUnique({
            where: { id: payload.sub },
            select: { id: true, email: true, phone: true, planId: true, status: true },
          });
          if (user && user.status === 'ACTIVE') {
            req.user = {
              id: user.id,
              sessionId: session.id,
              email: user.email,
              phone: user.phone,
              planId: user.planId,
              isAdmin: adminUserIds().has(user.id),
            };
          }
        }
      }
    }
  } catch (err) {
    logger.debug({ err }, 'optional_auth_skipped');
  }
  next();
};

/** 管理员权限中间件 */
export const adminMiddleware: RequestHandler = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user?.isAdmin) {
    sendError(res, new AuthError(ErrorCode.UNAUTHORIZED, '需要管理员权限'), 'admin_middleware');
    return;
  }
  next();
};

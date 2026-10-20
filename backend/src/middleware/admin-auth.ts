/**
 * 运营后台认证中间件
 * - 解析 Bearer Admin Access Token（payload: sub/sid/role，独立 secret）
 * - 校验 AdminSession 有效性（未吊销/未过期）与 AdminUser 状态
 * - 角色与权限每次请求从 DB 读取（角色变更立即生效，不信 token 内的旧角色）
 * 注意：与用户端 authMiddleware 完全独立——用户 token 在本中间件必然验失败。
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyAdminAccessToken } from '../lib/admin-jwt';
import prisma from '../lib/prisma';
import { sendError } from '../lib/response';
import { AdminError, ErrorCode } from '../lib/errors';
import { permissionsForRole, type Permission } from '../lib/admin-permissions';
import type { AdminRole } from '@prisma/client';

export interface AdminAuthRequest extends Request {
  admin?: {
    id: string;
    sessionId: string;
    username: string;
    name: string;
    /** DB 中的角色枚举（每请求从 DB 读取，不用 token 里的快照） */
    role: AdminRole;
    permissions: Permission[];
  };
}

export const adminAuthMiddleware: RequestHandler = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '未登录或登录已过期', 401);
    }

    const payload = verifyAdminAccessToken(authHeader.substring(7));
    if (!payload) {
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '登录已过期，请重新登录', 401);
    }

    // 会话必须仍有效（支持服务端吊销/踢下线）
    const session = await prisma.adminSession.findFirst({
      where: {
        id: payload.sid,
        adminUserId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!session) {
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '登录状态已失效，请重新登录', 401);
    }

    const admin = await prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, name: true, role: true, status: true },
    });
    if (!admin || admin.status !== 'ACTIVE') {
      throw new AdminError(ErrorCode.ADMIN_ACCOUNT_DISABLED, '账号不存在或已被禁用', 403);
    }

    req.admin = {
      id: admin.id,
      sessionId: session.id,
      username: admin.username,
      name: admin.name,
      role: admin.role,
      permissions: permissionsForRole(admin.role),
    };
    next();
  } catch (error) {
    sendError(res, error, 'admin_auth_middleware');
  }
};

/** 从请求上下文取当前管理员（路由 handler 内使用；经过中间件必然存在） */
export function requireAdmin(req: AdminAuthRequest): NonNullable<AdminAuthRequest['admin']> {
  if (!req.admin) {
    // 理论上不可达（路由已挂 adminAuthMiddleware）；防御性编程
    throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, '未登录', 401);
  }
  return req.admin;
}

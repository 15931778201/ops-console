/**
 * 管理员账号管理服务（权限 admin:manage，仅 SUPER_ADMIN）
 * - 创建：密码策略校验（≥12 位大小写数字、不含用户名）+ bcrypt(12) + 首次登录强制绑定 TOTP
 * - 角色/状态变更：末位 SUPER_ADMIN 保护（禁止降级/禁用最后一个超级管理员）；禁止操作自己
 * - 禁用/改密：自动吊销全部会话（立即失效）
 */

import bcrypt from 'bcryptjs';
import type { AdminRole, AdminStatus, AdminUser } from '@prisma/client';
import prisma from '../lib/prisma';
import { validateAdminPassword } from '../lib/admin-password';
import { adminSessionService } from './admin-session.service';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { AdminError, ErrorCode, ValidationError } from '../lib/errors';
import type { AdminContext } from './admin-auth.service';

export interface CreateAdminInput {
  username: string;
  password: string;
  name: string;
  role: AdminRole;
}

export interface UpdateAdminInput {
  role?: AdminRole;
  status?: AdminStatus;
  password?: string;
}

function toAdminView(admin: AdminUser) {
  return {
    id: admin.id,
    username: admin.username,
    name: admin.name,
    role: admin.role,
    status: admin.status,
    totpEnabled: admin.totpEnabled,
    mustBindTotp: admin.mustBindTotp,
    lastLoginAt: admin.lastLoginAt,
    lastLoginIp: admin.lastLoginIp,
    createdBy: admin.createdBy,
    createdAt: admin.createdAt,
  };
}

/** 统计仍在职的 SUPER_ADMIN 数量（末位保护） */
async function countActiveSuperAdmins(excludeId?: string): Promise<number> {
  return prisma.adminUser.count({
    where: {
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

export const adminUserService = {
  async createAdmin(
    input: CreateAdminInput,
    actorId: string,
    context: AdminContext = {}
  ): Promise<ReturnType<typeof toAdminView>> {
    const username = input.username.trim();
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      throw new ValidationError('用户名需为 3-32 位字母、数字、- 或 _');
    }
    if (!input.name?.trim()) {
      throw new ValidationError('姓名不能为空');
    }
    const check = validateAdminPassword(input.password, username);
    if (!check.ok) {
      throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, `密码策略：${check.problems.join('；')}`, 401);
    }

    const existing = await prisma.adminUser.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existing) {
      throw new ValidationError('用户名已存在');
    }

    const created = await prisma.adminUser.create({
      data: {
        username,
        name: input.name.trim(),
        role: input.role,
        passwordHash: await bcrypt.hash(input.password, 12),
        mustBindTotp: true,
        createdBy: actorId,
      },
    });

    await audit.record({
      actorType: 'ADMIN',
      actorId: actorId,
      action: 'admin.created',
      targetType: 'AdminUser',
      targetId: created.id,
      metadata: { role: created.role, username: created.username },
      requestId: context.requestId,
    });
    logger.info({ actorId, targetId: created.id, role: created.role }, 'admin_created');
    return toAdminView(created);
  },

  async listAdmins(query: { page: number; pageSize: number }): Promise<{
    items: Array<ReturnType<typeof toAdminView>>;
    total: number;
  }> {
    const [admins, total] = await Promise.all([
      prisma.adminUser.findMany({
        orderBy: { createdAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.adminUser.count(),
    ]);
    return { items: admins.map(toAdminView), total };
  },

  async getAdmin(id: string): Promise<ReturnType<typeof toAdminView>> {
    const admin = await prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new ValidationError('管理员不存在');
    return toAdminView(admin);
  },

  /**
   * 更新角色/状态/密码。
   * 保护规则：不能操作自己；不能禁用/降级最后一个在职 SUPER_ADMIN。
   */
  async updateAdmin(
    id: string,
    input: UpdateAdminInput,
    actorId: string,
    context: AdminContext = {}
  ): Promise<ReturnType<typeof toAdminView>> {
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) throw new ValidationError('管理员不存在');

    if (id === actorId) {
      throw new AdminError(ErrorCode.ADMIN_PERMISSION_DENIED, '不能修改自己的账号', 403);
    }

    const data: {
      role?: AdminRole;
      status?: AdminStatus;
      passwordHash?: string;
    } = {};

    // 末位 SUPER_ADMIN 保护：降级角色或禁用状态都会移除唯一超管
    const willLeaveSuperAdmin =
      target.role === 'SUPER_ADMIN' &&
      ((input.role !== undefined && input.role !== 'SUPER_ADMIN') ||
        (input.status !== undefined && input.status !== 'ACTIVE'));
    if (willLeaveSuperAdmin) {
      const others = await countActiveSuperAdmins(id);
      if (others === 0) {
        throw new AdminError(
          ErrorCode.ADMIN_APPROVAL_CONFLICT,
          '系统至少需要一名在职 SUPER_ADMIN',
          409
        );
      }
    }

    if (input.role !== undefined) data.role = input.role;
    if (input.status !== undefined) data.status = input.status;
    if (input.password !== undefined) {
      const check = validateAdminPassword(input.password, target.username);
      if (!check.ok) {
        throw new AdminError(ErrorCode.ADMIN_INVALID_CREDENTIALS, `密码策略：${check.problems.join('；')}`, 401);
      }
      data.passwordHash = await bcrypt.hash(input.password, 12);
    }

    if (Object.keys(data).length === 0) {
      return toAdminView(target);
    }

    const updated = await prisma.adminUser.update({ where: { id }, data });

    // 禁用或重置密码 → 立即吊销全部会话
    if (input.status === 'DISABLED' || input.password !== undefined) {
      const count = await adminSessionService.revokeAll(id, 'admin_updated');
      logger.info({ targetId: id, count }, 'admin_sessions_revoked_after_update');
    }

    await audit.record({
      actorType: 'ADMIN',
      actorId: actorId,
      action: 'admin.updated',
      targetType: 'AdminUser',
      targetId: id,
      metadata: {
        role: input.role,
        status: input.status,
        passwordReset: input.password !== undefined,
      },
      requestId: context.requestId,
    });
    return toAdminView(updated);
  },
};

export { toAdminView as toAdminUserView };

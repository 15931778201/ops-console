/**
 * 运营后台·管理员账号管理（/api/admin/v1/admins）
 * 权限：admin:manage（矩阵中仅 SUPER_ADMIN 持有）
 * 能力：列表 / 创建 / 改角色 / 禁用启用 / 重置密码（末位 SUPER_ADMIN 保护在 service 层）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { adminUserService } from '../../services/admin-user.service';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { asyncHandler } from '../../lib/async-handler';
import { sendPaginated, sendSuccess } from '../../lib/response';
import type { AdminRole, AdminStatus } from '@prisma/client';

const router = Router();

router.use(rbac('admin:manage'));

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /admins */
router.get(
  '/',
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const query = listQuery.parse(req.query);
    const { items, total } = await adminUserService.listAdmins(query);
    sendPaginated(res, items, {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    });
  })
);

/** GET /admins/:id —— 管理员详情 */
router.get(
  '/:id',
  asyncHandler(async (req: AdminAuthRequest, res) => {
    sendSuccess(res, await adminUserService.getAdmin(req.params.id!));
  })
);

const createSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(32),
  role: z.enum(['SUPER_ADMIN', 'OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR']),
});

/** POST /admins —— 创建管理员（首次登录强制绑定 TOTP） */
router.post(
  '/',
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = createSchema.parse(req.body);
    const admin = await adminUserService.createAdmin(
      data as { username: string; password: string; name: string; role: AdminRole },
      req.admin!.id,
      { requestId: req.requestId }
    );
    sendSuccess(res, admin, 201);
  })
);

const updateSchema = z.object({
  role: z.enum(['SUPER_ADMIN', 'OPERATOR', 'SUPPORT', 'FINANCE', 'AUDITOR']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  password: z.string().min(8).max(128).optional(),
});

/** PUT /admins/:id —— 角色/状态/密码（不能操作自己；末位 SUPER_ADMIN 保护） */
router.put(
  '/:id',
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const data = updateSchema.parse(req.body);
    const admin = await adminUserService.updateAdmin(
      req.params.id!,
      data as { role?: AdminRole; status?: AdminStatus; password?: string },
      req.admin!.id,
      { requestId: req.requestId }
    );
    sendSuccess(res, admin);
  })
);

export default router;

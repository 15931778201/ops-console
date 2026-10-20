/**
 * 运营后台 API v1 挂载点（/api/admin/v1）
 * 结构：/auth（免登录：两步登录/TOTP/刷新）→ adminAuthMiddleware → 业务路由（RBAC）。
 * 业务模块（用户/订单/审批/账本/仪表盘等）按 A6.2–A6.8 逐批接入。
 */

import { Router } from 'express';
import authRoutes from './auth';
import adminsRoutes from './admins';
import usersRoutes from './users';
import ordersRoutes from './orders';
import reconciliationsRoutes from './reconciliations';
import ledgerRoutes from './ledger';
import catalogRoutes from './catalog';
import dashboardRoutes from './dashboard';
import approvalsRoutes from './approvals';
import flagsRoutes from './flags';
import auditLogsRoutes from './audit-logs';
import alertsRoutes from './alerts';
import { adminAuthMiddleware } from '../../middleware/admin-auth';
import { sendError } from '../../lib/response';
import { NotFoundError } from '../../lib/errors';

const router = Router();

// 免登录：认证相关（内部自带限流与 mfaToken 校验）
router.use('/auth', authRoutes);

// 其余全部请求先过管理认证（JWT + 会话 + 账号状态）
router.use(adminAuthMiddleware);

// 业务路由（逐个权限码校验）
router.use('/admins', adminsRoutes);
router.use('/users', usersRoutes);
router.use('/orders', ordersRoutes);
router.use('/reconciliations', reconciliationsRoutes);
router.use('/approvals', approvalsRoutes);
router.use('/ledger', ledgerRoutes);
router.use('/catalog', catalogRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/flags', flagsRoutes);
router.use('/audit-logs', auditLogsRoutes);
router.use('/alerts', alertsRoutes);

// 兜底 404：必须显式声明。
// 否则未匹配的 /api/admin/v1/* 会落到下一个挂载点 /api/admin（旧 break-glass 通道），
// 返回 401 UNAUTHORIZED——把"路由不存在"误报成"未登录"，前端难以区分。
router.use((req, res) => {
  sendError(res, new NotFoundError(`后台接口不存在：${req.method} ${req.originalUrl}`), 'admin_v1_not_found');
});

export default router;

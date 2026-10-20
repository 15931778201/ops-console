/**
 * 审计查询与导出路由（A6.8）
 * - GET  /api/admin/v1/audit-logs        审计列表（多维筛选 + 分页 + 按动作计数）
 * - GET  /api/admin/v1/audit-logs/meta   动作字典（分组 + 中文标签）
 * - POST /api/admin/v1/audit-logs/export 导出（CSV/JSON，限频 + 导出本身入审计）
 *
 * 权限：读 `audit:read`，导出 `audit:export`（SUPER_ADMIN / FINANCE / AUDITOR）。
 *
 * 导出是敏感操作，三条安全约束：
 *  ① 限频（10 分钟 3 次，超了 429）
 *  ② 硬上限 10000 行（超出在响应头标注 truncated）
 *  ③ **导出行为本身写审计**（audit.exported）——否则导出就是审计的盲区
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { sendSuccess } from '../../lib/response';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { RateLimitError } from '../../lib/errors';
import {
  getAuditLog,
  listAuditLogs,
  exportAuditLogs,
  recordExport,
  checkExportRate,
  AUDIT_ACTION_GROUPS,
  EXPORT_MAX_ROWS,
  type AuditQuery,
} from '../../services/admin-audit.service';

const router = Router();

/** 查询参数（GET query 与 POST body 共用） */
const auditQuerySchema = z.object({
  actorId: z.string().max(64).optional(),
  actorType: z.enum(['USER', 'ADMIN', 'SYSTEM']).optional(),
  action: z.string().max(64).optional(),
  actionPrefix: z.string().max(64).optional(),
  targetType: z.string().max(32).optional(),
  targetId: z.string().max(64).optional(),
  requestId: z.string().max(64).optional(),
  reason: z.string().max(200).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/admin/v1/audit-logs —— 审计列表 */
router.get(
  '/',
  rbac('audit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const q = auditQuerySchema.parse(req.query) as AuditQuery;
    const result = await listAuditLogs(q);
    sendSuccess(res, {
      items: result.items,
      pagination: {
        total: result.total,
        page: q.page ?? 1,
        pageSize: q.pageSize ?? 20,
      },
      byAction: result.byAction,
    });
  })
);

/** GET /api/admin/v1/audit-logs/meta —— 动作字典（放在 /export 之前避免路由歧义） */
router.get(
  '/meta',
  rbac('audit:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, {
      groups: Object.entries(AUDIT_ACTION_GROUPS).map(([key, g]) => ({
        key,
        label: g.label,
        actions: g.actions,
      })),
      exportMaxRows: EXPORT_MAX_ROWS,
    });
  })
);

const exportSchema = auditQuerySchema.extend({
  format: z.enum(['csv', 'json']).default('csv'),
});

/** POST /api/admin/v1/audit-logs/export —— 导出 */
router.post(
  '/export',
  rbac('audit:export'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const { format, ...q } = exportSchema.parse(req.body ?? {}) as AuditQuery & { format: 'csv' | 'json' };

    // 限频按**管理员**计数（服务层 checkExportRate）。
    // 刻意不再叠加 rateLimiter 中间件：两层各自计数会导致
    // "中间件按 IP 放行、服务层按人拦截" 的不一致，且限频语义应只有一处。
    const rate = await checkExportRate(req.admin!.id);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      // 429 而非 400：这是限流（可重试），不是参数错误
      throw new RateLimitError(`导出过于频繁，请 ${rate.retryAfterSec} 秒后再试`);
    }

    const result = await exportAuditLogs(q, format);

    // 导出本身入审计——谁在什么时候导出了什么，必须可追溯
    await recordExport(req.admin!.id, {
      format,
      rowCount: result.rowCount,
      truncated: result.truncated,
      filters: q as Record<string, unknown>,
    });

    res.setHeader('content-type', result.contentType);
    res.setHeader('content-disposition', `attachment; filename="${result.filename}"`);
    // 暴露行数与截断标记，方便调用方校验
    res.setHeader('x-export-row-count', String(result.rowCount));
    res.setHeader('x-export-truncated', String(result.truncated));
    res.send(result.content);
  })
);

/** GET /api/admin/v1/audit-logs/:id —— 审计详情（须在 /meta 之后注册） */
router.get(
  '/:id',
  rbac('audit:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    sendSuccess(res, await getAuditLog(req.params.id!));
  })
);

export default router;
/**
 * 监控告警路由（T6.5）
 * - GET  /api/admin/v1/alerts              告警列表（多维筛选 + 分页）
 * - GET  /api/admin/v1/alerts/meta         规则清单与实时命中状态
 * - GET  /api/admin/v1/alerts/stats        近 N 天统计（复盘/SLA）
 * - POST /api/admin/v1/alerts/evaluate     手动触发评估（**告警演练入口**）
 * - POST /api/admin/v1/alerts/:key/ack     确认规则（值班已处理）
 * - POST /api/admin/v1/alerts/reset-states 重置规则状态（改阈值或演练后用）
 *
 * 权限：读 `alert:read`，演练/确认 `alert:manage`。
 * 阈值不可在 API 改（属配置，须走发布流程）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { sendSuccess } from '../../lib/response';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { audit } from '../../lib/audit';
import {
  getAlert,
  listAlerts,
  listRulesWithState,
  alertStats,
  triggerEvaluation,
  acknowledgeRule,
  resetStates,
} from '../../services/admin-alert.service';
import { hasChannel } from '../../services/alert-channels';
import { config } from '../../lib/config';

const router = Router();

const listSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']).optional(),
  status: z.enum(['pending', 'sent', 'failed', 'suppressed', 'manual']).optional(),
  ruleKey: z.string().max(64).optional(),
  onlyOpen: z.enum(['true', 'false']).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/admin/v1/alerts */
router.get(
  '/',
  rbac('alert:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const q = listSchema.parse(req.query);
    const result = await listAlerts({
      ...q,
      onlyOpen: q.onlyOpen === 'true',
    });
    sendSuccess(res, {
      items: result.items,
      pagination: {
        total: result.total,
        page: q.page ?? 1,
        pageSize: q.pageSize ?? 20,
      },
      firingCount: result.firingCount,
      bySeverity: result.bySeverity,
    });
  })
);

/** GET /api/admin/v1/alerts/events/:id —— 告警事件详情 */
router.get(
  '/events/:id',
  rbac('alert:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    sendSuccess(res, await getAlert(req.params.id!));
  })
);

/** GET /api/admin/v1/alerts/meta —— 规则与通道状态 */
router.get(
  '/meta',
  rbac('alert:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, {
      rules: await listRulesWithState(),
      channel: {
        configured: hasChannel(),
        /** 未配置通道时告警仍落库，但不外发 */
        note: hasChannel() ? null : '未配置 ALERT_WEBHOOK_URL：告警仅落库不外发',
      },
      policy: {
        consecutiveThreshold: config.ALERT_CONSECUTIVE_THRESHOLD,
        silenceMs: config.ALERT_SILENCE_MS,
        maxRetries: config.ALERT_MAX_RETRIES,
        evalIntervalMs: config.ALERT_EVAL_INTERVAL_MS,
      },
    });
  })
);

/** GET /api/admin/v1/alerts/stats —— 近 N 天统计 */
router.get(
  '/stats',
  rbac('alert:read'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const days = Number(req.query.days ?? 7);
    sendSuccess(res, await alertStats(Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7));
  })
);

/** POST /api/admin/v1/alerts/evaluate —— 手动触发评估（告警演练） */
router.post(
  '/evaluate',
  rbac('alert:manage'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const result = await triggerEvaluation();
    await audit.record({
      actorType: 'ADMIN',
      actorId: req.admin!.id,
      action: 'alert.evaluated',
      targetType: 'AlertRule',
      reason: (req.body as { reason?: string })?.reason ?? '手动触发告警评估',
      metadata: result as unknown as Record<string, unknown>,
    });
    sendSuccess(res, result);
  })
);

/** POST /api/admin/v1/alerts/:key/ack —— 确认（值班已处理） */
router.post(
  '/:key/ack',
  rbac('alert:manage'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const key = String(req.params.key ?? '');
    const parsed = z.object({ reason: z.string().min(2).max(500) }).parse(req.body ?? {});
    await acknowledgeRule(key);
    await audit.record({
      actorType: 'ADMIN',
      actorId: req.admin!.id,
      action: 'alert.acknowledged',
      targetType: 'AlertRule',
      targetId: key,
      reason: parsed.reason,
    });
    sendSuccess(res, { ruleKey: key, firing: false });
  })
);

/** POST /api/admin/v1/alerts/reset-states —— 重置规则状态 */
router.post(
  '/reset-states',
  rbac('alert:manage'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const parsed = z
      .object({ ruleKey: z.string().max(64).optional(), reason: z.string().min(2).max(500) })
      .parse(req.body ?? {});
    const result = await resetStates(parsed.ruleKey);
    await audit.record({
      actorType: 'ADMIN',
      actorId: req.admin!.id,
      action: 'alert.states_reset',
      targetType: 'AlertRule',
      targetId: parsed.ruleKey ?? 'all',
      reason: parsed.reason,
      metadata: result as unknown as Record<string, unknown>,
    });
    sendSuccess(res, result);
  })
);

export default router;
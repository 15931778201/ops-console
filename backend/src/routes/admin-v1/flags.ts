/**
 * 系统开关路由（A6.8）
 * - GET    /api/admin/v1/flags          开关列表（含是否有 override）
 * - PATCH  /api/admin/v1/flags/:key    设置开关（幂等；值未变不写审计）
 * - POST   /api/admin/v1/flags/:key/reset  恢复代码默认值
 * - GET    /api/admin/v1/flags/meta     开关字典（标签/说明/默认值）
 *
 * 权限：读 `flag:read`（SUPER_ADMIN + FINANCE + AUDITOR），写 `flag:write`（仅 SUPER_ADMIN）。
 * 开关直接影响资金链路（停收），因此写权限不外放。
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { sendSuccess } from '../../lib/response';
import { rbac } from '../../middleware/rbac';
import type { AdminAuthRequest } from '../../middleware/admin-auth';
import { audit } from '../../lib/audit';
import { NotFoundError } from '../../lib/errors';
import {
  listFlags,
  setFlag,
  resetFlag,
  FLAG_DEFS,
  FLAG_KEYS,
  type FlagKey,
} from '../../services/feature-flag.service';

const router = Router();

const isFlagKey = (v: string): v is FlagKey => (FLAG_KEYS as string[]).includes(v);

const updateFlagSchema = z.object({
  value: z.boolean(),
  reason: z.string().min(2).max(500),
});

/** GET /api/admin/v1/flags —— 开关列表 */
router.get(
  '/',
  rbac('flag:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, { items: await listFlags() });
  })
);

/** GET /api/admin/v1/flags/meta —— 开关字典（放在 /:key 之前避免被当作 key 匹配） */
router.get(
  '/meta',
  rbac('flag:read'),
  asyncHandler(async (_req: AdminAuthRequest, res) => {
    sendSuccess(res, {
      items: FLAG_KEYS.map((k) => ({
        key: k,
        flag: FLAG_DEFS[k].key,
        label: FLAG_DEFS[k].label,
        description: FLAG_DEFS[k].description,
        defaultValue: FLAG_DEFS[k].default,
      })),
    });
  })
);

/** PATCH /api/admin/v1/flags/:key —— 设置开关 */
router.patch(
  '/:key',
  rbac('flag:write'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const key = String(req.params.key ?? '');
    if (!isFlagKey(key)) {
      throw new NotFoundError(`未知开关：${key}（可用：${FLAG_KEYS.join(', ')}）`);
    }
    const data = updateFlagSchema.parse(req.body);
    const result = await setFlag(key, data.value, req.admin!.id, data.reason);

    // 幂等：值未变化不写审计，避免噪声
    if (result.changed) {
      await audit.record({
        actorType: 'ADMIN',
        actorId: req.admin!.id,
        action: 'flag.updated',
        targetType: 'FeatureFlag',
        targetId: result.flag,
        reason: data.reason,
        metadata: {
          previousValue: result.previousValue,
          value: result.value,
          // 停收是高风险操作，额外标记便于告警与检索
          critical: key === 'paymentAcceptingOrders',
        },
      });
    }

    sendSuccess(res, result);
  })
);

/** POST /api/admin/v1/flags/:key/reset —— 恢复代码默认值 */
router.post(
  '/:key/reset',
  rbac('flag:write'),
  asyncHandler(async (req: AdminAuthRequest, res) => {
    const key = String(req.params.key ?? '');
    if (!isFlagKey(key)) {
      throw new NotFoundError(`未知开关：${key}`);
    }
    const parsed = z.object({ reason: z.string().min(2).max(500) }).parse(req.body ?? {});

    const before = (await listFlags()).find((f) => f.key === key)?.value ?? FLAG_DEFS[key].default;
    const result = await resetFlag(key, req.admin!.id, parsed.reason);

    await audit.record({
      actorType: 'ADMIN',
      actorId: req.admin!.id,
      action: 'flag.reset',
      targetType: 'FeatureFlag',
      targetId: result.flag,
      reason: parsed.reason,
      metadata: { previousValue: before, value: result.value, critical: key === 'paymentAcceptingOrders' },
    });

    sendSuccess(res, result);
  })
);

export default router;
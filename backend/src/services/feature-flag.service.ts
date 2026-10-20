/**
 * 功能开关服务（A6.8）
 *
 * 设计要点：
 *  - 开关值存`feature_flags` 表（key 主键 + JSON value），**代码内置默认值**：
 *    库里没记录时用默认值，且启动即生效——不依赖任何 seed，开关能力天然可用。
 *  - 停收（`payment.acceptingOrders=false`）是**最高优先级**的开关：
 *    开启后 `/api/payment/create-order` 返回 503，但**查询与退款不受影响**
 *    （验收标准第 5 条）。这意味着开关必须精确挂在写入口上，不能挂中间件。
 *  - 读取走**进程内缓存 + 短 TTL**：下单是高频路径，不能每次都打库；
 *    变更时主动 `invalidate()` 使全进程立即可见，满足「60 秒内生效」且实际是毫秒级。
 *  - 缓存故障时**降级为默认值而非抛错**：开关系统挂掉不该连带打挂下单主链路。
 */

import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { ValidationError } from '../lib/errors';

/** 开关定义（含代码内默认值与中文标签） */
export const FLAG_DEFS = {
  /** 停收：关闭后 create-order 503，查询/退款不受影响 */
  paymentAcceptingOrders: {
    key: 'payment.acceptingOrders',
    default: true,
    label: '新订单收单',
    description: '关闭后新订单创建被拒（503），已付款用户的查询与退款不受影响',
  },
  /** 注册开关 */
  registrationOpen: {
    key: 'registration.open',
    default: true,
    label: '开放注册',
    description: '关闭后新用户无法注册（不影响已存在用户登录与使用）',
  },
  /** Mock 支付通道（仅开发/预生产可用） */
  paymentMockChannel: {
    key: 'payment.mockChannel',
    default: false,
    label: 'Mock 支付通道',
    description: '开发/预生产的模拟支付通道；生产环境禁止开启',
  },
} as const;

export type FlagKey = keyof typeof FLAG_DEFS;
export const FLAG_KEYS = Object.keys(FLAG_DEFS) as FlagKey[];

/** 开关快照（返回给前端与用户端） */
export interface FlagView {
  key: FlagKey;
  flag: string;
  value: boolean;
  label: string;
  description: string;
  /** 是否使用代码内置默认值（库里无记录） */
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  hasOverride: boolean;
}

// ==================== 缓存 ====================

/** key → { value, expiresAt }；TTL 极短（5s），且变更时主动失效 */
const cache = new Map<string, { value: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 5_000;

function invalidate(): void {
  cache.clear();
}

/** 强制刷新全部缓存（改开关后调用，使立即生效） */
export function invalidateFlagCache(): void {
  invalidate();
  logger.info('feature_flag_cache_invalidated');
}

// ==================== 读 ====================

/**
 * 读取单个布尔开关。库中无记录 → 用代码默认值。
 * 任何异常都降级为默认值（开关系统不可用不该打挂下单链路）。
 */
export async function isEnabled(key: FlagKey): Promise<boolean> {
  const def = FLAG_DEFS[key];
  const hit = cache.get(def.key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  try {
    const row = await prisma.featureFlag.findUnique({ where: { key: def.key } });
    const raw = row?.value;
    // 兼容几种存法：true / "true" / { enabled: true }
    let value = def.default;
    if (typeof raw === 'boolean') {
      value = raw;
    } else if (typeof raw === 'string') {
      value = raw === 'true';
    } else if (raw && typeof raw === 'object' && 'enabled' in raw) {
      value = (raw as { enabled: unknown }).enabled === true;
    }
    cache.set(def.key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.error({ err, key: def.key }, 'feature_flag_read_failed_fallback_to_default');
    return def.default;
  }
}

/** 一次性读取全部开关（管理端列表与用户端拉取共用） */
export async function listFlags(): Promise<FlagView[]> {
  const rows = await prisma.featureFlag.findMany({
    where: { key: { in: FLAG_KEYS.map((k) => FLAG_DEFS[k].key) } },
  });
  const byFlag = new Map(rows.map((r) => [r.key, r]));

  return FLAG_KEYS.map((k) => {
    const def = FLAG_DEFS[k];
    const row = byFlag.get(def.key);
    return {
      key: k,
      flag: def.key,
      value: coerce(row?.value, def.default),
      label: def.label,
      description: def.description,
      isDefault: row === undefined,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
      hasOverride: row !== undefined,
    };
  });
}

/** 用户端/管理端轻量读取：只要 key → boolean */
export async function getPublicFlags(): Promise<Record<string, boolean>> {
  const rows = await prisma.featureFlag.findMany({
    where: { key: { in: FLAG_KEYS.map((k) => FLAG_DEFS[k].key) } },
  });
  const byFlag = new Map(rows.map((r) => [r.key, coerce(r.value, FLAG_DEFS[r.key as FlagKey]?.default ?? false)]));
  const out: Record<string, boolean> = {};
  for (const k of FLAG_KEYS) out[k] = byFlag.get(FLAG_DEFS[k].key) ?? FLAG_DEFS[k].default;
  return out;
}

function coerce(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw === 'true';
  if (raw && typeof raw === 'object' && 'enabled' in raw) {
    return (raw as { enabled: unknown }).enabled === true;
  }
  return fallback;
}

// ==================== 写 ====================

export interface UpdateFlagResult {
  flag: string;
  previousValue: boolean;
  value: boolean;
  /** 值未变化 → 不写审计、不算一次变更 */
  changed: boolean;
}

/**
 * 设置开关。幂等：值相同直接返回 changed=false。
 * 变更后立即失效缓存（毫秒级全进程生效，远优于验收要求的 60 秒）。
 */
export async function setFlag(
  key: FlagKey,
  value: boolean,
  actorId: string,
  reason: string
): Promise<UpdateFlagResult> {
  const def = FLAG_DEFS[key];
  if (!reason || reason.trim().length < 2) {
    throw new ValidationError('操作原因至少 2 个字符');
  }

  const previousValue = await isEnabled(key);
  if (previousValue === value) {
    return { flag: def.key, previousValue, value, changed: false };
  }

  await prisma.featureFlag.upsert({
    where: { key: def.key },
    create: { key: def.key, value, description: def.description, updatedBy: actorId },
    update: { value, updatedBy: actorId },
  });

  // 立即失效：让下一次读取直接见新值
  invalidate();

  return { flag: def.key, previousValue, value, changed: true };
}

/** 恢复代码默认值（删除 override 记录） */
export async function resetFlag(
  key: FlagKey,
  _actorId: string,
  _reason: string
): Promise<{ flag: string; value: boolean }> {
  const def = FLAG_DEFS[key];
  await prisma.featureFlag.deleteMany({ where: { key: def.key } });
  invalidate();
  return { flag: def.key, value: def.default };
}

export default {
  isEnabled,
  listFlags,
  getPublicFlags,
  setFlag,
  resetFlag,
  invalidateFlagCache,
  FLAG_DEFS,
  FLAG_KEYS,
};
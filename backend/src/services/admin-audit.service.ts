/**
 * 审计查询与导出服务（A6.8）
 *
 * 设计要点：
 *  - **查询**：多维筛选（操作者/动作/对象/时间区间/requestId）+ 分页。
 *    支持「按动作前缀」筛选（如 `plan.*`）便于按模块回溯。
 *  - **导出**：CSV / JSON 两种格式。安全约束三条：
 *    ① 硬上限 10000 行——审计表会持续增长，不限量导出会拖垮数据库；
 *    ② 限频（默认 10 分钟 3 次）——导出是敏感操作，防止批量拖库；
 *    ③ **导出行为本身也写审计**（`audit.exported`）——谁在什么时候导出了什么，
 *       本身就是需要留痕的敏感事件，否则导出成了审计的盲区。
 *  - CSV 做**公式注入防护**：以 `= + - @` 开头的单元格值加前缀 `'`，
 *    防止 Excel 打开时执行公式（CSV 注入）。
 */

import prisma from '../lib/prisma';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { ValidationError, NotFoundError } from '../lib/errors';
import { getClient } from '../lib/redis';

// ==================== 动作字典 ====================

/** 审计动作 → 中文标签与分类（管理端筛选下拉用） */
export const AUDIT_ACTION_GROUPS: Record<string, { label: string; actions: string[] }> = {
  auth: {
    label: '认证与会话',
    actions: [
      'admin.login.success',
      'admin.login.mfa_failed',
      'admin.login.failed',
      'admin.logout',
      'admin.token.refreshed',
      'admin.token.reused',
      'admin.password.changed',
      'admin.totp.bound',
      'admin.totp.rebound',
    ],
  },
  admin: {
    label: '管理员账号',
    actions: ['admin.created', 'admin.updated', 'admin.disabled', 'admin.enabled', 'admin.session.revoked'],
  },
  user: {
    label: '用户管理',
    actions: ['user.disabled', 'user.enabled', 'user.session.revoked', 'user.viewed'],
  },
  order: {
    label: '订单与退款',
    actions: ['order.synced', 'order.closed', 'refund.applied', 'refund.requested'],
  },
  reconcile: {
    label: '对账处理',
    actions: ['reconcile.handled', 'reconcile.retried', 'reconcile.auto_rejected'],
  },
  approval: {
    label: '审批流',
    actions: [
      'approval.submitted',
      'approval.approved',
      'approval.rejected',
      'approval.cancelled',
      'approval.executed',
    ],
  },
  ledger: {
    label: '积分账本',
    actions: ['ledger.scanned'],
  },
  catalog: {
    label: '套餐与规则',
    actions: ['plan.updated', 'plan.activated', 'plan.deactivated', 'rule.updated'],
  },
  flag: {
    label: '系统开关',
    actions: ['flag.updated', 'flag.reset'],
  },
  audit: {
    label: '审计导出',
    actions: ['audit.exported'],
  },
};

export const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(AUDIT_ACTION_GROUPS).flatMap(([group, g]) =>
    g.actions.map((a) => [a, `${g.label}· ${a}`] as const)
  )
);

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

// ==================== 限频 ====================

/** 导出限频：10 分钟内最多 3 次 */
export const EXPORT_RATE = { max: 3, windowSec: 600 } as const;

/**
 * 导出限频计数（无 Redis 时降级为进程内内存计数，与现有 rate-limit 一致）。
 * 返回是否允许导出。
 */
export async function checkExportRate(adminId: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const redis = getClient();
  const key = `audit-export:${adminId}`;

  if (redis) {
    try {
      const n = await redis.incr(`ratelimit:${key}`);
      if (n === 1) await redis.expire(`ratelimit:${key}`, EXPORT_RATE.windowSec);
      if (n > EXPORT_RATE.max) {
        const ttl = await redis.ttl(`ratelimit:${key}`);
        return { allowed: false, retryAfterSec: Math.max(1, ttl) };
      }
      return { allowed: true, retryAfterSec: 0 };
    } catch (err) {
      logger.error({ err }, 'audit_export_ratelimit_failed');
    }
  }

  // 内存降级
  const m = memoryExportCounters.get(key);
  const now = Date.now();
  if (!m || m.expiresAt <= now) {
    memoryExportCounters.set(key, { count: 1, expiresAt: now + EXPORT_RATE.windowSec * 1000 });
    return { allowed: true, retryAfterSec: 0 };
  }
  m.count += 1;
  if (m.count > EXPORT_RATE.max) {
    return { allowed: false, retryAfterSec: Math.ceil((m.expiresAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

const memoryExportCounters = new Map<string, { count: number; expiresAt: number }>();

// ==================== 查询 ====================

export interface AuditQuery {
  actorId?: string;
  actorType?: string;
  /** 精确动作或前缀（`plan` 匹配 `plan.updated` 等） */
  action?: string;
  actionPrefix?: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  reason?: string;
  since?: Date;
  until?: Date;
  page?: number;
  pageSize?: number;
}

function buildWhere(q: AuditQuery): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (q.actorId) where.actorId = q.actorId;
  if (q.actorType) where.actorType = q.actorType;
  if (q.action) where.action = q.action;
  else if (q.actionPrefix) where.action = { startsWith: q.actionPrefix };
  if (q.targetType) where.targetType = q.targetType;
  if (q.targetId) where.targetId = q.targetId;
  if (q.requestId) where.requestId = q.requestId;
  if (q.reason) where.reason = { contains: q.reason, mode: 'insensitive' };
  if (q.since || q.until) {
    where.createdAt = {
      ...(q.since ? { gte: q.since } : {}),
      ...(q.until ? { lte: q.until } : {}),
    };
  }
  return where;
}

/** 审计列表（分页 + 按动作分组计数） */
export async function listAuditLogs(q: AuditQuery): Promise<{
  items: Array<{
    id: string;
    actorType: string;
    actorId: string | null;
    actorName: string | null;
    action: string;
    actionLabel: string;
    targetType: string | null;
    targetId: string | null;
    reason: string | null;
    metadata: unknown;
    requestId: string | null;
    createdAt: string;
  }>;
  total: number;
  byAction: Array<{ action: string; actionLabel: string; count: number }>;
}> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
  const where = buildWhere(q);

  const [rows, total, grouped] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.groupBy({ by: ['action'], where, _count: { _all: true } }),
  ]);

  // 补管理员姓名（审计里只有 actorId，前端要显示"谁做的"）
  const adminIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const admins = adminIds.length
    ? await prisma.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(admins.map((a) => [a.id, a.name] as const));

  return {
    items: rows.map((r) => ({
      id: r.id,
      actorType: r.actorType,
      actorId: r.actorId,
      actorName: r.actorId ? nameById.get(r.actorId) ?? null : null,
      action: r.action,
      actionLabel: actionLabel(r.action),
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      metadata: r.metadata,
      requestId: r.requestId,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    byAction: grouped
      .map((g) => ({
        action: g.action,
        actionLabel: actionLabel(g.action),
        count: g._count._all,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

/** 单条审计详情（详情页用） */
export async function getAuditLog(id: string): Promise<{
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  actionLabel: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: unknown;
  requestId: string | null;
  createdAt: string;
}> {
  const r = await prisma.auditLog.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('审计记录不存在');
  const admin = r.actorId
    ? await prisma.adminUser.findUnique({ where: { id: r.actorId }, select: { name: true } })
    : null;
  return {
    id: r.id,
    actorType: r.actorType,
    actorId: r.actorId,
    actorName: admin?.name ?? null,
    action: r.action,
    actionLabel: actionLabel(r.action),
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    metadata: r.metadata,
    requestId: r.requestId,
    createdAt: r.createdAt.toISOString(),
  };
}

// ==================== 导出 ====================

/** 导出硬上限：防止一次性拖垮审计表 */
export const EXPORT_MAX_ROWS = 10_000;

export interface ExportResult {
  filename: string;
  contentType: string;
  content: string;
  rowCount: number;
  truncated: boolean;
}

/**
 * 导出审计日志（CSV / JSON）。
 *
 * 限频与「导出本身入审计」由**路由层**调用（便于返回 429 与统一错误处理）；
 * 本函数只负责取数与序列化。
 */
export async function exportAuditLogs(
  q: AuditQuery,
  format: 'csv' | 'json'
): Promise<ExportResult> {
  const where = buildWhere(q);
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: EXPORT_MAX_ROWS + 1, // 多取一条用于判断是否被截断
  });

  const truncated = rows.length > EXPORT_MAX_ROWS;
  const sliced = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `audit-logs-${stamp}.${format}`;

  if (format === 'json') {
    return {
      filename,
      contentType: 'application/json; charset=utf-8',
      content: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          filters: q,
          rowCount: sliced.length,
          truncated,
          rows: sliced.map((r) => ({
            id: r.id,
            actorType: r.actorType,
            actorId: r.actorId,
            action: r.action,
            actionLabel: actionLabel(r.action),
            targetType: r.targetType,
            targetId: r.targetId,
            reason: r.reason,
            metadata: r.metadata,
            requestId: r.requestId,
            createdAt: r.createdAt.toISOString(),
          })),
        },
        null,
        2
      ),
      rowCount: sliced.length,
      truncated,
    };
  }

  // CSV：带 BOM 以便 Excel 正确识别 UTF-8 中文
  const header = [
    '时间',
    '操作者类型',
    '操作者ID',
    '动作',
    '动作说明',
    '对象类型',
    '对象ID',
    '原因',
    'requestId',
    '元数据',
  ];
  const lines = [header.join(',')];
  for (const r of sliced) {
    lines.push(
      [
        r.createdAt.toISOString(),
        r.actorType,
        r.actorId ?? '',
        r.action,
        actionLabel(r.action),
        r.targetType ?? '',
        r.targetId ?? '',
        r.reason ?? '',
        r.requestId ?? '',
        r.metadata ? JSON.stringify(r.metadata) : '',
      ]
        .map(csvCell)
        .join(',')
    );
  }

  return {
    filename,
    contentType: 'text/csv; charset=utf-8',
    content: `\uFEFF${lines.join('\r\n')}`,
    rowCount: sliced.length,
    truncated,
  };
}

/** CSV 单元格转义 + **公式注入防护**（`=`/`+`/`-`/`@` 开头加前缀单引号） */
function csvCell(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 记录导出行为本身（敏感事件，必须留痕） */
export async function recordExport(
  adminId: string,
  info: { format: string; rowCount: number; truncated: boolean; filters: Record<string, unknown> }
): Promise<void> {
  await audit.record({
    actorType: 'ADMIN',
    actorId: adminId,
    action: 'audit.exported',
    targetType: 'AuditLog',
    reason: `导出审计日志（${info.format.toUpperCase()}，${info.rowCount} 行）`,
    metadata: info as unknown as Record<string, unknown>,
  });
}

/** 校验导出行数上限（供路由在参数阶段拦截） */
export function assertExportLimit(rowCount: number): void {
  if (rowCount > EXPORT_MAX_ROWS) {
    throw new ValidationError(`导出超过上限 ${EXPORT_MAX_ROWS} 行，请缩小时间区间`);
  }
}

export { NotFoundError };
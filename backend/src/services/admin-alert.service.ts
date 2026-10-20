/**
 * 告警查询与确认服务（T6.5 管理端）
 *
 * 职责边界：只读 + 确认，**不提供"手动改阈值"入口**——
 * 阈值属配置（ALERT_THRESHOLD_OVERRIDES / 代码默认值），
 * 改阈值要走发布流程，否则线上会出现"谁在什么时候把告警关了没人知道"。
 */

import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { NotFoundError } from '../lib/errors';
import { ALERT_RULES, evaluate, resetRuleState, acknowledge } from './alert.service';

export interface AlertListItem {
  id: string;
  severity: string;
  title: string;
  ruleKey: string | null;
  metric: string | null;
  value: number | null;
  threshold: number | null;
  hitStreak: number;
  status: string;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  detail: unknown;
}

export interface AlertListResult {
  items: AlertListItem[];
  total: number;
  /** 当前仍在告警中的规则数（未 resolved） */
  firingCount: number;
  bySeverity: Array<{ severity: string; count: number }>;
}

/** 单条告警事件详情（详情页用） */
export async function getAlert(id: string): Promise<AlertListItem> {
  const r = await prisma.alertEvent.findUnique({ where: { id } });
  if (!r) throw new NotFoundError('告警事件不存在');
  return {
    id: r.id,
    severity: r.severity,
    title: r.title,
    ruleKey: r.ruleKey,
    metric: r.metric,
    value: r.value,
    threshold: r.threshold,
    hitStreak: r.hitStreak,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError,
    sentAt: r.sentAt?.toISOString() ?? null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    detail: r.detail,
  };
}

export async function listAlerts(options: {
  severity?: string;
  status?: string;
  ruleKey?: string;
  onlyOpen?: boolean;
  since?: Date;
  until?: Date;
  page?: number;
  pageSize?: number;
}): Promise<AlertListResult> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));

  const where: Record<string, unknown> = {};
  if (options.severity) where.severity = options.severity;
  if (options.status) where.status = options.status;
  if (options.ruleKey) where.ruleKey = options.ruleKey;
  if (options.onlyOpen) where.resolvedAt = null;
  if (options.since || options.until) {
    where.createdAt = {
      ...(options.since ? { gte: options.since } : {}),
      ...(options.until ? { lte: options.until } : {}),
    };
  }

  const [rows, total, firingCount, grouped] = await Promise.all([
    prisma.alertEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.alertEvent.count({ where }),
    prisma.alertEvent.count({ where: { resolvedAt: null, source: 'monitor' } }),
    prisma.alertEvent.groupBy({ by: ['severity'], where, _count: { _all: true } }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      severity: r.severity,
      title: r.title,
      ruleKey: r.ruleKey,
      metric: r.metric,
      value: r.value,
      threshold: r.threshold,
      hitStreak: r.hitStreak,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      sentAt: r.sentAt?.toISOString() ?? null,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      detail: r.detail,
    })),
    total,
    firingCount,
    bySeverity: grouped
      .map((g) => ({ severity: g.severity, count: g._count._all }))
      .sort((a, b) => a.severity.localeCompare(b.severity)),
  };
}

/** 规则清单 + 当前命中状态（供前端展示阈值与实时状态） */
export async function listRulesWithState(): Promise<
  Array<{
    key: string;
    name: string;
    severity: string;
    metric: string;
    threshold: number;
    compare: string;
    windowMs: number;
    firing: boolean;
    hitStreak: number;
    lastFiredAt: string | null;
    lastResolvedAt: string | null;
  }>
> {
  const states = await prisma.alertRuleState.findMany();
  const byKey = new Map(states.map((s) => [s.ruleKey, s] as const));

  return ALERT_RULES.map((r) => {
    const st = byKey.get(r.key);
    return {
      key: r.key,
      name: r.name,
      severity: r.severity,
      metric: r.metric,
      threshold: r.threshold,
      compare: r.compare,
      windowMs: r.windowMs,
      firing: st?.firing ?? false,
      hitStreak: st?.hitStreak ?? 0,
      lastFiredAt: st?.lastFiredAt?.toISOString() ?? null,
      lastResolvedAt: st?.lastResolvedAt?.toISOString() ?? null,
    };
  });
}

/** 手动触发一次评估（告警演练用） */
export async function triggerEvaluation(): Promise<{
  evaluated: number;
  triggered: string[];
  recovered: string[];
  collectFailed: string[];
}> {
  const result = await evaluate();
  logger.info({ ...result }, 'alert_manual_evaluation');
  return result;
}

/** 确认（值班已处理）：把规则置为非 firing，停止后续命中累积 */
export async function acknowledgeRule(ruleKey: string): Promise<void> {
  if (!ALERT_RULES.some((r) => r.key === ruleKey)) {
    throw new NotFoundError(`未知告警规则：${ruleKey}`);
  }
  await acknowledge(ruleKey);
}

/** 重置规则状态（改阈值或演练后用，避免旧 streak 干扰新判定） */
export async function resetStates(ruleKey?: string): Promise<{ reset: number }> {
  const reset = await resetRuleState(ruleKey);
  logger.info({ ruleKey, reset }, 'alert_rule_states_reset');
  return { reset };
}

/** 告警统计（近 N 天）：用于事后复盘与 SLA 评估 */
export async function alertStats(days = 7): Promise<{
  windowDays: number;
  total: number;
  resolved: number;
  unresolved: number;
  sendFailed: number;
  suppressed: number;
  byRule: Array<{ ruleKey: string; title: string; count: number }>;
  avgResolveMinutes: number | null;
}> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [total, resolved, unresolved, sendFailed, suppressed, byRule, resolvedRows] = await Promise.all([
    prisma.alertEvent.count({ where: { createdAt: { gte: since }, source: 'monitor' } }),
    prisma.alertEvent.count({ where: { createdAt: { gte: since }, resolvedAt: { not: null } } }),
    prisma.alertEvent.count({ where: { createdAt: { gte: since }, resolvedAt: null } }),
    prisma.alertEvent.count({ where: { createdAt: { gte: since }, status: 'failed' } }),
    prisma.alertEvent.count({ where: { createdAt: { gte: since }, status: 'suppressed' } }),
    prisma.alertEvent.groupBy({
      by: ['ruleKey', 'title'],
      where: { createdAt: { gte: since }, source: 'monitor' },
      _count: { _all: true },
    }),
    prisma.alertEvent.findMany({
      where: { createdAt: { gte: since }, resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
    }),
  ]);

  const durations = resolvedRows
    .map((r) => (r.resolvedAt!.getTime() - r.createdAt.getTime()) / 60000)
    .filter((d) => d >= 0);
  const avgResolveMinutes = durations.length
    ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2))
    : null;

  return {
    windowDays: days,
    total,
    resolved,
    unresolved,
    sendFailed,
    suppressed,
    byRule: byRule
      .map((r) => ({ ruleKey: r.ruleKey ?? 'manual', title: r.title, count: r._count._all }))
      .sort((a, b) => b.count - a.count),
    avgResolveMinutes,
  };
}
/**
 * 监控告警 API 客户端（T6.5）
 *
 * 权限：读 `alert:read`，演练/确认/重置 `alert:manage`。
 *
 * 一个刻意的缺席：**没有"改阈值"接口**。阈值属配置（ALERT_THRESHOLD_OVERRIDES
 * 或代码默认值），改它必须走发布流程。若这里出现 setThreshold 之类的调用，
 * 等于给"悄悄把告警调没"开了后门，前端也不该提供这种暗示。
 */

import { api } from './api-client';

export type AlertSeverity = 'P0' | 'P1' | 'P2';

/** 事件投递状态：pending=待发 / sent=已外发 / failed=外发失败 / suppressed=未配通道仅落库 / manual=人工登记 */
export type AlertStatus = 'pending' | 'sent' | 'failed' | 'suppressed' | 'manual';

export interface AlertItem {
  id: string;
  severity: AlertSeverity;
  title: string;
  ruleKey: string | null;
  metric: string | null;
  value: number | null;
  threshold: number | null;
  hitStreak: number;
  status: AlertStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  detail: unknown;
}

export interface AlertRule {
  key: string;
  name: string;
  severity: AlertSeverity;
  metric: string;
  threshold: number;
  /** 比较符：gt=大于 / lt=小于 / gte / lte / eq / ne */
  compare: string;
  windowMs: number;
  firing: boolean;
  hitStreak: number;
  lastFiredAt: string | null;
  lastResolvedAt: string | null;
}

export interface AlertPolicy {
  /** 连续命中多少次才外发（防单轮毛刺） */
  consecutiveThreshold: number;
  /** 静默窗口：同规则在该窗口内不重复外发 */
  silenceMs: number;
  maxRetries: number;
  evalIntervalMs: number;
}

export interface AlertMeta {
  rules: AlertRule[];
  channel: { configured: boolean; note: string | null };
  policy: AlertPolicy;
}

export interface AlertListResult {
  items: AlertItem[];
  pagination: { total: number; page: number; pageSize: number };
  /** 当前仍在告警中的规则数（未恢复） */
  firingCount: number;
  bySeverity: Array<{ severity: string; count: number }>;
}

export interface AlertStats {
  windowDays: number;
  total: number;
  resolved: number;
  unresolved: number;
  sendFailed: number;
  suppressed: number;
  byRule: Array<{ ruleKey: string; title: string; count: number }>;
  avgResolveMinutes: number | null;
}

export interface EvaluateResult {
  evaluated: number;
  triggered: string[];
  recovered: string[];
  collectFailed: string[];
}

export interface AlertListParams {
  severity?: AlertSeverity | '';
  status?: AlertStatus | '';
  ruleKey?: string;
  onlyOpen?: boolean;
  page?: number;
  pageSize?: number;
}

function clean(params: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === null) continue;
    out[k] = v as string | number | boolean;
  }
  return out;
}

export const alertsApi = {
  list: (params: AlertListParams) =>
    api.get<AlertListResult>('/alerts', clean({ ...params, onlyOpen: params.onlyOpen ? 'true' : undefined })),

  get: (id: string) => api.get<AlertItem>(`/alerts/events/${encodeURIComponent(id)}`),

  meta: () => api.get<AlertMeta>('/alerts/meta'),

  stats: (days = 7) => api.get<AlertStats>('/alerts/stats', { days }),

  /** 立即检测（告警演练入口）。原因进审计。 */
  evaluate: (reason: string) => api.post<EvaluateResult>('/alerts/evaluate', { reason }),

  /** 确认：值班已处理，把规则置为非 firing */
  acknowledge: (ruleKey: string, reason: string) =>
    api.post<{ ruleKey: string; firing: boolean }>(`/alerts/${encodeURIComponent(ruleKey)}/ack`, { reason }),

  /** 重置规则状态（改阈值或演练后用，避免旧 streak 干扰新判定） */
  resetStates: (ruleKey: string | undefined, reason: string) =>
    api.post<{ reset: number }>('/alerts/reset-states', { ruleKey, reason }),
};

// ---------- 展示辅助 ----------

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  P0: 'P0 立即处置',
  P1: 'P1 当班处理',
  P2: 'P2 观察跟进',
};

export const SEVERITY_KIND: Record<AlertSeverity, 'danger' | 'warning' | 'default'> = {
  P0: 'danger',
  P1: 'warning',
  P2: 'default',
};

export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = {
  pending: '待外发',
  sent: '已通知',
  failed: '外发失败',
  suppressed: '仅落库',
  manual: '人工登记',
};

export const ALERT_STATUS_KIND: Record<AlertStatus, 'default' | 'primary' | 'success' | 'warning' | 'danger'> =
  {
    pending: 'warning',
    sent: 'success',
    failed: 'danger',
    suppressed: 'default',
    manual: 'primary',
  };

/** 把后端 compare 翻成中文表达式，避免运营对着 gte/gte 猜语义 */
export function compareText(rule: AlertRule): string {
  const map: Record<string, string> = {
    gt: '大于',
    gte: '大于等于',
    lt: '小于',
    lte: '小于等于',
    eq: '等于',
    ne: '不等于',
  };
  const op = map[rule.compare] ?? rule.compare;
  return `${op} ${rule.threshold}`;
}

/** 窗口长度（毫秒转人类可读） */
export function windowText(ms: number): string {
  if (ms <= 0) return '即时';
  const min = Math.round(ms / 60000);
  if (min < 60) return `近 ${min} 分钟`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `近 ${hour} 小时`;
  return `近 ${Math.round(hour / 24)} 天`;
}
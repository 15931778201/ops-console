/**
 * 仪表盘 API 客户端（A6.7）
 * 数据只读快照（dashboard_snapshots），由定时任务每 5 分钟聚合写入。
 */

import { api } from './api-client';

export type Scope = 'today' | 'd7' | 'd30';

export interface DashboardMetrics {
  users: { registrations: number; activeLogins: number; suspended: number };
  payment: {
    orders: number;
    paidOrders: number;
    /** 0~1 */
    successRate: number;
    gmvCents: number;
    avgOrderCents: number;
    refundedOrders: number;
  };
  anomalies: {
    stalePendingOrders: number;
    invalidSignatureEvents: number;
    duplicateNotifyEvents: number;
    openReconciliations: number;
    mismatchedAccounts: number;
    negativeAccounts: number;
  };
  credits: { grantedTotal: number; consumedTotal: number; adjustCount: number; adjustNet: number };
  system: { dbOk: boolean; snapshotAgeMs: number | null };
}

export interface DashboardView {
  scope: Scope;
  generatedAt: string | null;
  stale: boolean;
  metrics: DashboardMetrics | null;
}

/** 异常指标的跳转 key（与后端 ANOMALY_LINKS 对应） */
export type AnomalyKey =
  | 'stalePendingOrders'
  | 'invalidSignatureEvents'
  | 'duplicateNotifyEvents'
  | 'openReconciliations'
  | 'mismatchedAccounts'
  | 'negativeAccounts';

interface LinkSpec {
  to: string;
  query: Record<string, string>;
  label: string;
}

/**
 * 异常指标 → 跳转配置。
 * 与后端 `dashboard.service.ts` 的 ANOMALY_LINKS 保持一致；
 * 本地定义一份是刻意的：前端渲染跳转不需等后端返回，减少一次依赖。
 */
const ANOMALY_LINKS: Record<AnomalyKey, LinkSpec> = {
  stalePendingOrders: { to: '/orders', query: { status: 'PENDING' }, label: '待支付超时订单' },
  invalidSignatureEvents: { to: '/orders', query: {}, label: '回调验签失败' },
  duplicateNotifyEvents: { to: '/reconcile', query: { diffType: 'DUPLICATE_NOTIFY' }, label: '重复回调' },
  openReconciliations: { to: '/reconcile', query: {}, label: '对账差异' },
  mismatchedAccounts: { to: '/ledger/anomalies', query: {}, label: '账本不平账户' },
  negativeAccounts: { to: '/ledger/anomalies', query: { reason: 'NEGATIVE_BALANCE' }, label: '负值余额账户' },
};

export const dashboardApi = {
  read: (scope: Scope) => api.get<DashboardView>('/dashboard', { scope }),
  refresh: (scope: Scope) => api.post<DashboardView>('/dashboard/refresh', { scope }),
  anomalyLink: (key: AnomalyKey): LinkSpec | undefined => ANOMALY_LINKS[key],
  links: ANOMALY_LINKS,
};
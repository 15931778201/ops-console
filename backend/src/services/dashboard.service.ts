/**
 * 运营后台·仪表盘服务（A6.7）
 *
 * 设计要点（设计文档 M1）：
 *  - 指标由定时任务每 5 分钟聚合并写入 `dashboard_snapshots` 表，
 *    读取接口只读 snapshot，**不做实时 COUNT 大表**（避免压库）。
 *  - 三个 scope：today / d7 / d30，各存一份快照。
 *  - 异常区每个指标返回 `linkTo`（跳转路径 + 查询参数），
 *    前端渲染成可点击数字，跳到对应筛选页。
 *
 * 指标口径（务必与 E2E 断言一致）：
 *  - 成功率 = PAID 订单数 / 区间内创建的订单数（分母含未支付，对账视角）
 *  - GMV = PAID 订单 amountCents 之和（分）
 *  - 客单价 = GMV / PAID 订单数（分，保留两位）
 *  - 发放总量 = GRANT+RESET+BONUS+INVITE_GRANT 的 delta 绝对值之和
 *  - 消耗总量 = CONSUME 的 amount 绝对值之和
 */

import prisma from '../lib/prisma';
import { adminLedgerService } from './admin-ledger.service';
import { logger } from '../lib/logger';

export const SCOPES = ['today', 'd7', 'd30'] as const;
export type Scope = (typeof SCOPES)[number];

/** scope → 回溯起点（今天从本地 00:00 起算） */
function scopeStart(scope: Scope): Date {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (scope === 'd7') start.setDate(start.getDate() - 6);
  if (scope === 'd30') start.setDate(start.getDate() - 29);
  return start;
}

/**
 * 取「本地日历日」对应的 UTC 午夜，用作 metricDate（@db.Date）。
 *
 * 关键：Prisma 对 `@db.Date` 按 **UTC 日期部分** 序列化。若直接传本地午夜
 * （UTC+8 下是前一日 16:00Z），写库日期会整体前移一天，读回比较也永远不相等——
 * 导致仪表盘在任何非 UTC 时区下恒为 stale。此处统一归一化。
 */
function localDayAsUtc(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

export interface DashboardMetrics {
  users: {
    registrations: number;
    activeLogins: number;
    suspended: number;
  };
  payment: {
    orders: number;
    paidOrders: number;
    /** 0~1，四位小数 */
    successRate: number;
    gmvCents: number;
    avgOrderCents: number;
    refundedOrders: number;
  };
  anomalies: {
    /** 待支付超时未关 */
    stalePendingOrders: number;
    /** 回调验签失败 */
    invalidSignatureEvents: number;
    /** 重复回调（被幂等拦截的） */
    duplicateNotifyEvents: number;
    /** 对账差异未处理 */
    openReconciliations: number;
    /** 账本不平账户 */
    mismatchedAccounts: number;
    /** 负值余额账户 */
    negativeAccounts: number;
  };
  credits: {
    grantedTotal: number;
    consumedTotal: number;
    adjustCount: number;
    adjustNet: number;
  };
  /** 系统健康（不属于时间区间，每次实时读） */
  system: {
    dbOk: boolean;
    snapshotAgeMs: number | null;
  };
}

export interface DashboardView {
  scope: Scope;
  /** 快照生成时间；null 表示快照缺失（前端提示"指标计算中"） */
  generatedAt: string | null;
  /** 快照新鲜度：超过 15 分钟视为过期 */
  stale: boolean;
  metrics: DashboardMetrics | null;
}

/** 各异常指标的跳转配置（前端渲染成可点击数字） */
export const ANOMALY_LINKS = {
  stalePendingOrders: { to: '/orders', query: { status: 'PENDING' }, label: '待支付超时订单' },
  invalidSignatureEvents: { to: '/orders', query: {}, label: '回调验签失败' },
  duplicateNotifyEvents: { to: '/reconcile', query: { diffType: 'DUPLICATE_NOTIFY' }, label: '重复回调' },
  openReconciliations: { to: '/reconcile', query: {}, label: '对账差异' },
  mismatchedAccounts: { to: '/ledger', query: { tab: 'anomalies' }, label: '账本不平账户' },
  negativeAccounts: { to: '/ledger', query: { tab: 'anomalies', reason: 'NEGATIVE_BALANCE' }, label: '负值余额账户' },
} as const;

/**
 * 计算某个 scope 的指标（写 snapshot 与实时读共用同一函数，保证口径一致）。
 */
async function computeMetrics(scope: Scope): Promise<DashboardMetrics> {
  const since = scopeStart(scope);

  const [
    registrations,
    activeLogins,
    suspended,
    ordersAgg,
    paidAgg,
    refundedOrders,
    stalePending,
    invalidSig,
    grantAgg,
    consumeAgg,
    adjustAgg,
    anomScan,
  ] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.user.count({ where: { lastLoginAt: { gte: since } } }),
    prisma.user.count({ where: { status: 'SUSPENDED' } }),
    prisma.order.count({ where: { createdAt: { gte: since } } }),
    prisma.order.aggregate({
      where: { status: 'PAID', createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { amountCents: true },
    }),
    prisma.order.count({ where: { status: 'REFUNDED', createdAt: { gte: since } } }),
    // 待支付超时：创建超过 30 分钟仍 PENDING（订单 expiresAt 由 order.service 设置）
    prisma.order.count({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } },
    }),
    prisma.paymentEvent.count({
      where: { signatureValid: false, createdAt: { gte: since } },
    }),
    prisma.creditTransaction.aggregate({
      where: {
        type: { in: ['GRANT', 'RESET', 'BONUS', 'INVITE_GRANT'] },
        status: 'SETTLED',
        createdAt: { gte: since },
      },
      _sum: { amount: true },
    }),
    prisma.creditTransaction.aggregate({
      where: { type: 'CONSUME', status: 'SETTLED', createdAt: { gte: since } },
      _sum: { amount: true },
    }),
    prisma.creditTransaction.aggregate({
      where: { type: 'ADJUST', createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    adminLedgerService.scanAnomalies(),
  ]);

  // 对账差异未处理
  const openReconciliations = await prisma.reconciliationRecord.count({
    where: { handledAt: null },
  });

  // 重复回调：eventType 命中 notify/success 但processed=false 且签名有效（被幂等拦截）
  const duplicateNotifyEvents = await prisma.paymentEvent.count({
    where: {
      signatureValid: true,
      processed: false,
      eventType: { contains: 'notify' },
      createdAt: { gte: since },
    },
  });

  const paidOrders = paidAgg._count._all;
  const gmvCents = paidAgg._sum.amountCents ?? 0;

  let dbOk = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbOk = false;
  }

  return {
    users: { registrations, activeLogins, suspended },
    payment: {
      orders: ordersAgg,
      paidOrders,
      successRate: ordersAgg === 0 ? 0 : Number((paidOrders / ordersAgg).toFixed(4)),
      gmvCents,
      avgOrderCents: paidOrders === 0 ? 0 : Number((gmvCents / paidOrders).toFixed(2)),
      refundedOrders,
    },
    anomalies: {
      stalePendingOrders: stalePending,
      invalidSignatureEvents: invalidSig,
      duplicateNotifyEvents,
      openReconciliations,
      mismatchedAccounts: anomScan.anomalies,
      negativeAccounts: anomScan.negative,
    },
    credits: {
      grantedTotal: Math.abs(grantAgg._sum.amount ?? 0),
      consumedTotal: Math.abs(consumeAgg._sum.amount ?? 0),
      adjustCount: adjustAgg._count._all,
      adjustNet: adjustAgg._sum.amount ?? 0,
    },
    system: { dbOk, snapshotAgeMs: null },
  };
}

export const dashboardService = {
  /**
   * 刷新并落库某scope 的快照（定时任务调用）。
   * 唯一键 (metricDate, scope) → 重复执行是 upsert，天然幂等。
   */
  async refresh(scope: Scope): Promise<{ scope: Scope; generatedAt: string; metrics: DashboardMetrics }> {
    const metrics = await computeMetrics(scope);
    const today = localDayAsUtc();

    await prisma.dashboardSnapshot.upsert({
      where: { metricDate_scope: { metricDate: today, scope } },
      create: { metricDate: today, scope, metrics: metrics as unknown as object },
      update: { metrics: metrics as unknown as object, createdAt: new Date() },
    });

    logger.info({ scope, gmv: metrics.payment.gmvCents, orders: metrics.payment.orders }, 'dashboard_snapshot_refreshed');
    return { scope, generatedAt: new Date().toISOString(), metrics };
  },

  /** 刷新全部 scope（定时任务用） */
  async refreshAll(): Promise<{ refreshed: number }> {
    for (const scope of SCOPES) {
      await this.refresh(scope);
    }
    return { refreshed: SCOPES.length };
  },

  /**
   * 读快照。**不实时计算**——避免压库（设计文档 M1 的核心约束）。
   * 若当天快照缺失，回退到最近一天并标记 stale。
   */
  async read(scope: Scope): Promise<DashboardView> {
    const today = localDayAsUtc();

    const snapshot = await prisma.dashboardSnapshot.findFirst({
      where: { scope },
      orderBy: { metricDate: 'desc' },
    });

    if (!snapshot) {
      return { scope, generatedAt: null, stale: true, metrics: null };
    }

    const ageMs = Date.now() - snapshot.createdAt.getTime();
    // 同一天但超过 15 分钟未刷新 → 标记 stale（提示"指标计算中"）
    const isToday = snapshot.metricDate.getTime() === today.getTime();
    const stale = isToday ? ageMs > 15 * 60 * 1000 : true;

    const metrics = snapshot.metrics as unknown as DashboardMetrics;
    metrics.system.snapshotAgeMs = ageMs; // 读时补充，不落库（下次刷新会重算）

    return {
      scope,
      generatedAt: snapshot.createdAt.toISOString(),
      stale,
      metrics,
    };
  },

  /** 手动触发刷新（后台按钮，运营想立刻看最新数字时用） */
  async refreshNow(scope: Scope): Promise<DashboardView> {
    await this.refresh(scope);
    return this.read(scope);
  },

  meta() {
    return {
      scopes: SCOPES,
      scopeLabels: { today: '今日', d7: '近 7 日', d30: '近 30 日' } as Record<Scope, string>,
      anomalyLinks: ANOMALY_LINKS,
    };
  },
};

export default dashboardService;
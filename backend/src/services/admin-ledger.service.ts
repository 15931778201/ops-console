/**
 * 运营后台·积分账本服务（A6.6）
 * 能力：
 *  - 全局流水查询（跨用户多维筛选 + 金额汇总，只读）
 *  - 不平/负值账户检测（投影 balance/bonusBalance vs 流水重算）
 *  - 账户详情（含周期、版本、最近流水）
 *  - 单账户重算校验（只读，不改库）
 *  - 手动触发不平账户全量扫描
 *
 * 设计约束（对齐设计文档 M4）：
 *  - 账本只读：这里不提供任何写库能力。调账只能走审批流（A6.5 的 approvalService）。
 *  - 流水按 ROLLED_BACK 排除出重算（回滚流水冲正后不应影响余额），
 *    但列表仍展示（置灰划线由前端处理）。
 *  - 不平检测用单条 SQL 做投影与流水的全量对比，避免 N+1。
 *  - 负值账户（balance < 0）单列一类——账本负值防护理论上不该出现，出现即为事故。
 */

import type { LedgerEntryStatus, Prisma, TransactionType } from '@prisma/client';
import prisma from '../lib/prisma';
import { ledgerService } from './ledger.service';
import { ValidationError, NotFoundError } from '../lib/errors';
import { logger } from '../lib/logger';

/** 流水类型中文标签（前端兜底用，服务端也返回避免字典不同步） */
export const TXN_TYPE_LABELS: Record<TransactionType, string> = {
  CONSUME: '消费',
  GRANT: '发放',
  RESET: '周期重置',
  REFUND: '退款冲正',
  ADJUST: '人工调整',
  INVITE_GRANT: '邀请奖励',
  BONUS: '奖励',
};

export const TXN_STATUS_LABELS: Record<LedgerEntryStatus, string> = {
  PENDING: '预扣中',
  SETTLED: '已结算',
  ROLLED_BACK: '已回滚',
};

/** 不平原因分类 */
export const DISCREPANCY_REASONS = [
  'BALANCE_MISMATCH',
  'BONUS_MISMATCH',
  'BOTH_MISMATCH',
  'NEGATIVE_BALANCE',
  'NO_TRANSACTION_BALANCE',
] as const;
export type DiscrepancyReason = (typeof DISCREPANCY_REASONS)[number];

export const DISCREPANCY_REASON_LABELS: Record<DiscrepancyReason, string> = {
  BALANCE_MISMATCH: '订阅积分不平',
  BONUS_MISMATCH: '奖励积分不平',
  BOTH_MISMATCH: '两个维度均不平',
  NEGATIVE_BALANCE: '余额为负（账本负值防护被绕过）',
  NO_TRANSACTION_BALANCE: '无任何流水却有余额（凭空造数据）',
};

export interface LedgerListQuery {
  page: number;
  pageSize: number;
  /** 用户 ID 精确匹配 */
  userId?: string;
  /** 用户邮箱/昵称模糊（跨表搜索，前端主要用这个） */
  userSearch?: string;
  type?: TransactionType;
  status?: LedgerEntryStatus;
  toolSlug?: string;
  /** 关联交易 ID（referenceId / billingTxnId 模糊） */
  reference?: string;
  createdFrom?: string;
  createdTo?: string;
}

export interface LedgerListResult {
  items: Array<{
    id: string;
    userId: string;
    userEmail: string | null;
    userName: string | null;
    type: TransactionType;
    typeLabel: string;
    status: LedgerEntryStatus;
    amount: number;
    deltaBalance: number;
    deltaBonus: number;
    balanceAfterBalance: number;
    balanceAfterBonus: number;
    toolSlug: string | null;
    fileCount: number | null;
    referenceId: string | null;
    billingTxnId: string | null;
    linkedTxnId: string | null;
    description: string | null;
    createdAt: string;
  }>;
  total: number;
  summary: {
    /** 参与汇总的条目数（= total） */
    count: number;
    /** 净变动合计（含扣减为负） */
    netAmount: number;
    sumDeltaBalance: number;
    sumDeltaBonus: number;
    /** 按类型分组计数与净额 */
    byType: Array<{ type: TransactionType; label: string; count: number; netAmount: number }>;
    /** 筛选范围内是否有 ROLLED_BACK（前端提示"含已回滚条目，金额未计入重算"） */
    hasRolledBack: boolean;
  };
}

export interface AnomalousAccount {
  userId: string;
  userEmail: string | null;
  userName: string | null;
  userStatus: string;
  planId: string;
  /** 投影值（credit_accounts） */
  balance: number;
  bonusBalance: number;
  /** 流水重算值 */
  expectedBalance: number;
  expectedBonus: number;
  /** 差额 = 投影 - 重算（>0 表示账上多，<0 表示账上少） */
  diffBalance: number;
  diffBonus: number;
  reason: DiscrepancyReason;
  /** 流水条数（0 表示账户无流水但有余额，纯造数据） */
  txnCount: number;
  lastTxnAt: string | null;
}

export interface AnomalyScanResult {
  checked: number;
  anomalies: number;
  negative: number;
  durationMs: number;
  /** 异常账户样本（邮箱等标识，仅供告警上下文与排障，不含隐私字段） */
  sample?: string[];
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(`${field} 不是合法时间`);
  }
  return d;
}

function buildWhere(query: LedgerListQuery): Prisma.CreditTransactionWhereInput {
  const where: Prisma.CreditTransactionWhereInput = {};

  if (query.userId) {
    where.userId = query.userId;
  } else if (query.userSearch) {
    // 邮箱/昵称模糊：先定位用户，再按 ID 过滤（避免跨表 OR 破坏 CreditTransaction 的索引使用）
    // 用户量级不大时此路径可接受；如需优化可改为子查询 IN
    where.user = {
      OR: [{ email: { contains: query.userSearch } }, { name: { contains: query.userSearch } }],
    };
  }

  if (query.type) where.type = query.type;
  if (query.status) where.status = query.status;
  if (query.toolSlug) where.toolSlug = query.toolSlug;
  if (query.reference) {
    where.OR = [{ referenceId: { contains: query.reference } }, { billingTxnId: { contains: query.reference } }];
  }

  const from = parseDate(query.createdFrom, 'createdFrom');
  const to = parseDate(query.createdTo, 'createdTo');
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = from;
    if (to) where.createdAt.lte = to;
  }
  return where;
}

export const adminLedgerService = {
  /**
   * 全局流水查询。
   * 汇总口径：含筛选范围内全部状态（ROLLED_BACK 也计入 netAmount），
   * 前端据此提示"含已回滚条目"；重算口径由 ledgerService.recompute 单独给出。
   */
  async listTransactions(query: LedgerListQuery): Promise<LedgerListResult> {
    const page = Math.max(1, query.page);
    const pageSize = Math.min(100, Math.max(1, query.pageSize));
    const where = buildWhere(query);

    const [rows, total, grouped, agg, rolledBack] = await Promise.all([
      prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.creditTransaction.count({ where }),
      prisma.creditTransaction.groupBy({ by: ['type'], where, _count: { _all: true }, _sum: { amount: true } }),
      prisma.creditTransaction.aggregate({
        where,
        _sum: { amount: true, deltaBalance: true, deltaBonus: true },
      }),
      prisma.creditTransaction.count({ where: { AND: [where, { status: 'ROLLED_BACK' }] } }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.user.email,
        userName: r.user.name,
        type: r.type,
        typeLabel: TXN_TYPE_LABELS[r.type],
        status: r.status,
        amount: r.amount,
        deltaBalance: r.deltaBalance,
        deltaBonus: r.deltaBonus,
        balanceAfterBalance: r.balanceAfterBalance,
        balanceAfterBonus: r.balanceAfterBonus,
        toolSlug: r.toolSlug,
        fileCount: r.fileCount,
        referenceId: r.referenceId,
        billingTxnId: r.billingTxnId,
        linkedTxnId: r.linkedTxnId,
        description: r.description,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      summary: {
        count: total,
        netAmount: agg._sum.amount ?? 0,
        sumDeltaBalance: agg._sum.deltaBalance ?? 0,
        sumDeltaBonus: agg._sum.deltaBonus ?? 0,
        byType: grouped
          .map((g) => ({
            type: g.type,
            label: TXN_TYPE_LABELS[g.type],
            count: g._count._all,
            netAmount: g._sum.amount ?? 0,
          }))
          .sort((a, b) => b.count - a.count),
        hasRolledBack: rolledBack > 0,
      },
    };
  },

  /**
   * 检测不平/负值账户。
   * 用一条 SQL 做投影与流水的全量对比（GROUP BY + HAVING），避免 N+1 查询。
   * 只检测有流水的账户；无流水但余额非 0 的账户由 ledgerOrphanScan 兜底。
   */
  async listAnomalousAccounts(options: {
    page?: number;
    pageSize?: number;
    reason?: DiscrepancyReason;
  } = {}): Promise<{ items: AnomalousAccount[]; total: number }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));

    type Row = {
      userId: string;
      balance: number;
      bonusBalance: number;
      expectedBalance: number;
      expectedBonus: number;
      txnCount: number;
      lastTxnAt: Date | null;
    };

    const rows = await prisma.$queryRaw<Row[]>`
      SELECT
        a."userId"                                AS "userId",
        a."balance"                                AS "balance",
        a."bonusBalance"                           AS "bonusBalance",
        COALESCE(SUM(t."deltaBalance"), 0)::int    AS "expectedBalance",
        COALESCE(SUM(t."deltaBonus"), 0)::int      AS "expectedBonus",
        COUNT(t."id")::int                        AS "txnCount",
        MAX(t."createdAt")                         AS "lastTxnAt"
      FROM "credit_accounts" a
      -- LEFT JOIN 而非 JOIN：零流水却有余额的账户（凭空造数据）也必须被检出，
      -- 用 INNER JOIN 会把这类账户整行排除，形成检测盲区。
      LEFT JOIN "credit_transactions" t
        ON t."userId" = a."userId" AND t."status" <> 'ROLLED_BACK'
      GROUP BY a."userId", a."balance", a."bonusBalance"
      HAVING a."balance" <> COALESCE(SUM(t."deltaBalance"), 0)
          OR a."bonusBalance" <> COALESCE(SUM(t."deltaBonus"), 0)
          OR a."balance" < 0
          OR a."bonusBalance" < 0
      ORDER BY ABS(a."balance" - COALESCE(SUM(t."deltaBalance"), 0))
             + ABS(a."bonusBalance" - COALESCE(SUM(t."deltaBonus"), 0)) DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;

    if (rows.length === 0) return { items: [], total: 0 };

    const users = await prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, email: true, name: true, status: true, planId: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const items: AnomalousAccount[] = rows.map((r) => {
      const diffBalance = r.balance - r.expectedBalance;
      const diffBonus = r.bonusBalance - r.expectedBonus;
      let reason: DiscrepancyReason;
      if (r.balance < 0 || r.bonusBalance < 0) reason = 'NEGATIVE_BALANCE';
      else if (r.txnCount === 0) reason = 'NO_TRANSACTION_BALANCE';
      else if (diffBalance !== 0 && diffBonus !== 0) reason = 'BOTH_MISMATCH';
      else if (diffBalance !== 0) reason = 'BALANCE_MISMATCH';
      else reason = 'BONUS_MISMATCH';

      const u = userMap.get(r.userId);
      return {
        userId: r.userId,
        userEmail: u?.email ?? '(已删除)',
        userName: u?.name ?? '-',
        userStatus: u?.status ?? 'UNKNOWN',
        planId: u?.planId ?? '-',
        balance: r.balance,
        bonusBalance: r.bonusBalance,
        expectedBalance: r.expectedBalance,
        expectedBonus: r.expectedBonus,
        diffBalance,
        diffBonus,
        reason,
        txnCount: r.txnCount,
        lastTxnAt: r.lastTxnAt ? r.lastTxnAt.toISOString() : null,
      };
    });

    const filtered = options.reason ? items.filter((i) => i.reason === options.reason) : items;
    // 总数用同样的 SQL 去掉分页单独统计
    const countRows = await prisma.$queryRaw<Array<{ cnt: number }>>`
      SELECT COUNT(*)::int AS cnt FROM (
        SELECT a."userId"
        FROM "credit_accounts" a
        LEFT JOIN "credit_transactions" t
          ON t."userId" = a."userId" AND t."status" <> 'ROLLED_BACK'
        GROUP BY a."userId", a."balance", a."bonusBalance"
        HAVING a."balance" <> COALESCE(SUM(t."deltaBalance"), 0)
            OR a."bonusBalance" <> COALESCE(SUM(t."deltaBonus"), 0)
            OR a."balance" < 0
            OR a."bonusBalance" < 0
      ) x
    `;

    return { items: filtered, total: countRows[0]?.cnt ?? 0 };
  },

  /**
   * 全量扫描不平账户（供定时任务与"一键扫描"按钮复用）。
   * 只读：不修复、不改库——修复必须走审批流发反向调账（追加式闭环）。
   */
  async scanAnomalies(): Promise<AnomalyScanResult> {
    const started = Date.now();
    // pageSize=1 拿到 total；page=1/pageSize=100 拿到样本用于告警日志
    const { total } = await this.listAnomalousAccounts({ page: 1, pageSize: 1 });
    if (total === 0) {
      return { checked: 0, anomalies: 0, negative: 0, durationMs: Date.now() - started };
    }
    const { items } = await this.listAnomalousAccounts({ page: 1, pageSize: 100 });
    const negative = items.filter((i) => i.reason === 'NEGATIVE_BALANCE').length;

    logger.error(
      { anomalies: total, negative, sample: items.slice(0, 5).map((i) => i.userEmail) },
      'ledger_anomaly_detected'
    );

    return { checked: total, anomalies: total, negative, durationMs: Date.now() - started };
  },

  /** 账户详情：投影 + 周期 + 版本 + 最近流水 + 重算对比 */
  async getAccountDetail(userId: string): Promise<{
    user: { id: string; email: string | null; name: string | null; status: string; planId: string; createdAt: string };
    account: {
      balance: number;
      bonusBalance: number;
      monthlyQuota: number;
      periodStart: string | null;
      periodEnd: string | null;
      version: number;
      updatedAt: string;
    } | null;
    recompute: { balance: number; bonusBalance: number; matches: boolean };
    recentTransactions: Array<{
      id: string;
      type: TransactionType;
      typeLabel: string;
      status: LedgerEntryStatus;
      amount: number;
      deltaBalance: number;
      deltaBonus: number;
      createdAt: string;
      description: string | null;
    }>;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, status: true, planId: true, createdAt: true },
    });
    if (!user) throw new NotFoundError('用户不存在');

    const [account, recompute, recent] = await Promise.all([
      prisma.creditAccount.findUnique({ where: { userId } }),
      ledgerService.recompute(userId),
      prisma.creditTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      user: { ...user, createdAt: user.createdAt.toISOString() },
      account: account
        ? {
            balance: account.balance,
            bonusBalance: account.bonusBalance,
            monthlyQuota: account.monthlyQuota,
            periodStart: account.periodStart?.toISOString() ?? null,
            periodEnd: account.periodEnd?.toISOString() ?? null,
            version: account.version,
            updatedAt: account.updatedAt.toISOString(),
          }
        : null,
      recompute,
      recentTransactions: recent.map((r) => ({
        id: r.id,
        type: r.type,
        typeLabel: TXN_TYPE_LABELS[r.type],
        status: r.status,
        amount: r.amount,
        deltaBalance: r.deltaBalance,
        deltaBonus: r.deltaBonus,
        createdAt: r.createdAt.toISOString(),
        description: r.description,
      })),
    };
  },

  /**
   * 重算校验（只读）。返回投影 vs 流水重算的差异，不写库。
   * 与 adminUserMgmtService.recomputeLedger 同源，这里额外返回差额便于前端标红。
   */
  async verifyAccount(userId: string): Promise<{
    userId: string;
    balance: number;
    bonusBalance: number;
    expectedBalance: number;
    expectedBonus: number;
    diffBalance: number;
    diffBonus: number;
    matches: boolean;
    checkedAt: string;
  }> {
    const account = await prisma.creditAccount.findUnique({
      where: { userId },
      select: { balance: true, bonusBalance: true },
    });
    if (!account) throw new NotFoundError('积分账户不存在');

    const r = await ledgerService.recompute(userId);
    return {
      userId,
      balance: account.balance,
      bonusBalance: account.bonusBalance,
      expectedBalance: r.balance,
      expectedBonus: r.bonusBalance,
      diffBalance: account.balance - r.balance,
      diffBonus: account.bonusBalance - r.bonusBalance,
      matches: r.matches,
      checkedAt: new Date().toISOString(),
    };
  },

  /** 类型与状态字典（前端筛选下拉） */
  meta(): {
    types: Array<{ value: TransactionType; label: string }>;
    statuses: Array<{ value: LedgerEntryStatus; label: string }>;
    discrepancyReasons: Array<{ value: DiscrepancyReason; label: string }>;
  } {
    return {
      types: (Object.keys(TXN_TYPE_LABELS) as TransactionType[]).map((value) => ({
        value,
        label: TXN_TYPE_LABELS[value],
      })),
      statuses: (Object.keys(TXN_STATUS_LABELS) as LedgerEntryStatus[]).map((value) => ({
        value,
        label: TXN_STATUS_LABELS[value],
      })),
      discrepancyReasons: DISCREPANCY_REASONS.map((value) => ({ value, label: DISCREPANCY_REASON_LABELS[value] })),
    };
  },
};

export default adminLedgerService;
/**
 * 积分账本API 客户端（A6.6）
 * 权限：全部只读（credit:read）。**本模块无任何写库接口**——
 * 调账只能走审批流（/approvals），前端不提供任何绕过路径。
 */

import { api, type Page } from './api-client';

export type TxnType =
  | 'CONSUME'
  | 'GRANT'
  | 'RESET'
  | 'REFUND'
  | 'ADJUST'
  | 'INVITE_GRANT'
  | 'BONUS';

export type TxnStatus = 'PENDING' | 'SETTLED' | 'ROLLED_BACK';

export type DiscrepancyReason =
  | 'BALANCE_MISMATCH'
  | 'BONUS_MISMATCH'
  | 'BOTH_MISMATCH'
  | 'NEGATIVE_BALANCE'
  | 'NO_TRANSACTION_BALANCE';

export interface LedgerEntry {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  type: TxnType;
  typeLabel: string;
  status: TxnStatus;
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
}

export interface LedgerSummary {
  count: number;
  netAmount: number;
  sumDeltaBalance: number;
  sumDeltaBonus: number;
  byType: Array<{ type: TxnType; label: string; count: number; netAmount: number }>;
  hasRolledBack: boolean;
}

export interface LedgerPage extends Page<LedgerEntry> {
  summary: LedgerSummary;
}

export interface AnomalousAccount {
  userId: string;
  userEmail: string | null;
  userName: string | null;
  userStatus: string;
  planId: string;
  balance: number;
  bonusBalance: number;
  expectedBalance: number;
  expectedBonus: number;
  diffBalance: number;
  diffBonus: number;
  reason: DiscrepancyReason;
  txnCount: number;
  lastTxnAt: string | null;
}

export interface AccountDetail {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    status: string;
    planId: string;
    createdAt: string;
  };
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
    type: TxnType;
    typeLabel: string;
    status: TxnStatus;
    amount: number;
    deltaBalance: number;
    deltaBonus: number;
    createdAt: string;
    description: string | null;
  }>;
}

export interface VerifyResult {
  userId: string;
  balance: number;
  bonusBalance: number;
  expectedBalance: number;
  expectedBonus: number;
  diffBalance: number;
  diffBonus: number;
  matches: boolean;
  checkedAt: string;
}

export interface LedgerMeta {
  types: Array<{ value: TxnType; label: string }>;
  statuses: Array<{ value: TxnStatus; label: string }>;
  discrepancyReasons: Array<{ value: DiscrepancyReason; label: string }>;
}

export interface LedgerListParams {
  page?: number;
  pageSize?: number;
  userSearch?: string;
  userId?: string;
  type?: TxnType | '';
  status?: TxnStatus | '';
  toolSlug?: string;
  reference?: string;
  createdFrom?: string;
  createdTo?: string;
}

/** 去掉空字符串参数（后端 zod 收到空串会校验失败；api-client 的 buildUrl 也已过滤，这里保持显式） */
function clean(params: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === null) continue;
    out[k] = v as string | number | boolean;
  }
  return out;
}

export const ledgerApi = {
  meta: () => api.get<LedgerMeta>('/ledger/meta'),

  transactions: (params: LedgerListParams) =>
    api.get<LedgerPage>('/ledger/transactions', clean({ ...params })),

  anomalies: (params: { page?: number; pageSize?: number; reason?: DiscrepancyReason | '' }) =>
    api.get<Page<AnomalousAccount>>('/ledger/accounts/anomalies', clean(params)),

  scan: () =>
    api.post<{ checked: number; anomalies: number; negative: number; durationMs: number }>(
      '/ledger/accounts/scan'
    ),

  accountDetail: (userId: string) => api.get<AccountDetail>(`/ledger/accounts/${userId}`),

  verify: (userId: string) => api.get<VerifyResult>(`/ledger/accounts/${userId}/verify`),
};
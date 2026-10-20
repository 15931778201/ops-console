/**
 * 套餐/规则/邀请 API 客户端（A6.7）
 * 权限：读 plan:read / rule:read / invite:read；写 plan:write / rule:write。
 */

import { api, type Page } from './api-client';

export interface PlanListItem {
  id: string;
  name: string;
  monthlyCredits: number;
  priceCents: number;
  periodMonths: number;
  maxFiles: number;
  costTierAccess: string[];
  active: boolean;
  holderCount: number;
  updatedAt: string;
}

export interface PriceHistoryEntry {
  priceCents: number;
  monthlyCredits: number;
  changedAt: string;
  changedBy: string;
  reason?: string;
}

export interface PlanDetail extends Omit<PlanListItem, 'holderCount'> {
  features: Record<string, unknown>;
  holderCount: number;
  priceHistory: PriceHistoryEntry[] | null;
}

export interface PlanImpact {
  planId: string;
  planName: string;
  currentPriceCents: number;
  newPriceCents: number;
  holderCount: number;
  monthlyRevenueDeltaCents: number;
  pendingOrders: number;
  note: string;
}

export interface BillingRule {
  toolSlug: string;
  creditCost: number;
  minPlan: string;
  maxFilesPerTask: number;
  ruleVersion: string;
  active: boolean;
  updatedAt: string;
  recentUsage: { calls: number; credits: number };
}

export interface RuleImpact {
  toolSlug: string;
  currentCreditCost: number;
  newCreditCost: number;
  affectedUsers: number;
  recentCredits: number;
  projectedCredits: number;
  monthlyDeltaCredits: number;
  note: string;
}

export interface InviteCode {
  code: string;
  ownerUserId: string;
  ownerEmail: string | null;
  channel: string | null;
  maxUses: number | null;
  usedCount: number;
  rewardCredits: number;
  inviterCredits: number;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  expired: boolean;
}

export interface InviteRelation {
  id: string;
  inviteCode: string;
  inviterUserId: string;
  inviterEmail: string | null;
  inviteeUserId: string;
  inviteeEmail: string | null;
  status: string;
  inviterRewarded: boolean;
  inviteeRewarded: boolean;
  riskFlag: string | null;
  createdAt: string;
}

export interface InviteStats {
  totalCodes: number;
  activeCodes: number;
  totalRelations: number;
  rewardedRelations: number;
  pendingRewardRelations: number;
  riskFlagged: number;
  grantedCredits: number;
}

export const catalogApi = {
  plans: () => api.get<{ items: PlanListItem[] }>('/catalog/plans'),
  plan: (id: string) => api.get<PlanDetail>(`/catalog/plans/${id}`),
  planImpact: (id: string, newPriceCents: number) =>
    api.get<PlanImpact>(`/catalog/plans/${id}/impact`, { newPriceCents }),
  updatePlan: (
    id: string,
    body: {
      name?: string;
      monthlyCredits?: number;
      priceCents?: number;
      maxFiles?: number;
      costTierAccess?: string[];
      reason: string;
    }
  ) => api.patch<{ plan: PlanDetail; priceChanged: boolean }>(`/catalog/plans/${id}`, body),
  setPlanActive: (id: string, active: boolean, reason: string) =>
    api.post<{ id: string; active: boolean; holderCount: number }>(`/catalog/plans/${id}/active`, {
      active,
      reason,
    }),

  rules: () => api.get<{ items: BillingRule[] }>('/catalog/rules'),
  ruleImpact: (toolSlug: string, newCreditCost: number) =>
    api.get<RuleImpact>(`/catalog/rules/${toolSlug}/impact`, { newCreditCost }),
  updateRule: (
    toolSlug: string,
    body: { creditCost?: number; minPlan?: string; maxFilesPerTask?: number; active?: boolean; reason: string }
  ) =>
    api.patch<{
      toolSlug: string;
      ruleVersion: string;
      previousVersion: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(`/catalog/rules/${toolSlug}`, body),

  inviteCodes: (params: { page?: number; pageSize?: number } = {}) =>
    api.get<Page<InviteCode>>('/catalog/invites/codes', { ...params }),
  inviteRelations: (params: { page?: number; pageSize?: number; riskFlag?: string } = {}) =>
    api.get<Page<InviteRelation>>('/catalog/invites/relations', { ...params }),
  inviteStats: () => api.get<InviteStats>('/catalog/invites/stats'),
};
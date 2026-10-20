/**
 * 审批流 API（/api/admin/v1/approvals）
 * 契约见后端 `src/routes/admin-v1/approvals.ts` 与设计文档 M4/6.2。
 */

import { api, type Page } from './api-client';

export type ApprovalType =
  | 'CREDIT_ADJUST'
  | 'REFUND'
  | 'ORDER_CLOSE'
  | 'PLAN_CHANGE'
  | 'RULE_CHANGE'
  | 'INVITE_REWARD';

export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTED'
  | 'FAILED'
  | 'CANCELLED';

export interface CreditAdjustPayload {
  userId: string;
  deltaBalance: number;
  deltaBonus: number;
  reason: string;
}

export interface ApprovalView {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  payload: unknown;
  reason: string;
  ticketNo: string | null;
  applicantId: string;
  approverId: string | null;
  approvedAt: string | null;
  executedAt: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreditAdjustPreview {
  currentBalance: number;
  currentBonus: number;
  afterBalance: number;
  afterBonus: number;
  wouldGoNegative: boolean;
  requiresSuperAdmin: boolean;
  recentCount: number;
  maxAbs: number;
}

export const approvalApi = {
  list(
    query: {
      page?: number;
      pageSize?: number;
      type?: ApprovalType;
      status?: ApprovalStatus;
      applicantId?: string;
      mine?: boolean;
    } = {}
  ): Promise<Page<ApprovalView>> {
    return api.get<Page<ApprovalView>>('/approvals', query);
  },

  mineCount(): Promise<{ pendingCount: number }> {
    return api.get<{ pendingCount: number }>('/approvals/mine-count');
  },

  get(id: string): Promise<ApprovalView> {
    return api.get<ApprovalView>(`/approvals/${id}`);
  },

  submit(input: {
    type: 'CREDIT_ADJUST';
    payload: CreditAdjustPayload;
    reason: string;
    ticketNo?: string;
  }): Promise<ApprovalView> {
    return api.post<ApprovalView>('/approvals', input);
  },

  preview(payload: CreditAdjustPayload): Promise<CreditAdjustPreview> {
    return api.post<CreditAdjustPreview>('/approvals/preview', payload);
  },

  approve(id: string): Promise<ApprovalView> {
    return api.post<ApprovalView>(`/approvals/${id}/approve`);
  },

  reject(id: string, reason: string): Promise<ApprovalView> {
    return api.post<ApprovalView>(`/approvals/${id}/reject`, { reason });
  },

  cancel(id: string): Promise<ApprovalView> {
    return api.post<ApprovalView>(`/approvals/${id}/cancel`);
  },

  execute(id: string): Promise<ApprovalView> {
    return api.post<ApprovalView>(`/approvals/${id}/execute`);
  },
};

export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  CREDIT_ADJUST: '积分调账',
  REFUND: '订单退款',
  ORDER_CLOSE: '强制关单',
  PLAN_CHANGE: '套餐变更',
  RULE_CHANGE: '计费规则变更',
  INVITE_REWARD: '邀请奖励',
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: '待审批',
  APPROVED: '已批准待执行',
  REJECTED: '已拒绝',
  EXECUTED: '已执行',
  FAILED: '执行失败',
  CANCELLED: '已撤回',
};
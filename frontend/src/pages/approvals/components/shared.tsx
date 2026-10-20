import { Tag } from 'antd'

import type { ApprovalStatus, CreditAdjustPayload } from '@/lib/approval-api'

export const APPROVAL_STATUS_COLOR: Record<ApprovalStatus, string> = {
  PENDING: 'warning',
  APPROVED: 'processing',
  REJECTED: 'error',
  EXECUTED: 'success',
  FAILED: 'error',
  CANCELLED: 'default',
}

export function ApprovalStatusTag({ status, label }: { status: ApprovalStatus, label: string }) {
  return <Tag color={APPROVAL_STATUS_COLOR[status]}>{label}</Tag>
}

export function formatPayload(payload: unknown): string {
  const p = payload as Partial<CreditAdjustPayload> | null
  if (p && typeof p === 'object' && 'deltaBalance' in p) {
    const parts: string[] = []
    if (p.deltaBalance) parts.push(`订阅积分 ${p.deltaBalance > 0 ? '+' : ''}${p.deltaBalance}`)
    if (p.deltaBonus) parts.push(`奖励积分 ${p.deltaBonus > 0 ? '+' : ''}${p.deltaBonus}`)
    return parts.join('，')
  }
  return JSON.stringify(payload)
}

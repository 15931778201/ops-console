import { Segmented, Tag } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'

import type { TxnStatus, TxnType } from '@/lib/ledger-api'

export const TXN_TYPE_COLOR: Record<TxnType, string> = {
  CONSUME: 'warning',
  GRANT: 'success',
  RESET: 'processing',
  REFUND: 'processing',
  ADJUST: 'error',
  INVITE_GRANT: 'success',
  BONUS: 'success',
}

export const TXN_STATUS_COLOR: Record<TxnStatus, string> = {
  PENDING: 'warning',
  SETTLED: 'success',
  ROLLED_BACK: 'default',
}

export function TxnTypeTag({ type, label }: { type: TxnType, label: string }) {
  return <Tag color={TXN_TYPE_COLOR[type]}>{label}</Tag>
}

/** 全局流水 / 异常账户 两个独立页面之间的切换 */
export function LedgerTabs() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <Segmented
      className="mb-3"
      value={pathname.startsWith('/ledger/anomalies') ? '/ledger/anomalies' : '/ledger'}
      onChange={v => navigate(v as string)}
      options={[{ value: '/ledger', label: '全局流水' }, { value: '/ledger/anomalies', label: '异常账户' }]}
    />
  )
}

export const numClass = (n: number): string => (n < 0 ? 'text-red-500' : 'text-green-600')

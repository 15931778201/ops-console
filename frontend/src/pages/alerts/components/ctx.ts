import { useOutletContext } from 'react-router-dom'

import type { AlertMeta, AlertStats } from '@/lib/alerts-api'

export interface AlertsCtx {
  meta: AlertMeta
  stats: AlertStats | null
  canManage: boolean
  refresh: () => Promise<void>
}

export const useAlerts = (): AlertsCtx => useOutletContext<AlertsCtx>()

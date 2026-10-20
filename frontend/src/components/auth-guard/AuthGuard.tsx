import type { ReactNode } from 'react'

import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

import { hideLoading } from '@/plugins'
import { getRouteMeta } from '@/router/routeMeta'
import { useAuthStore } from '@/stores/authStore'

/** 路由守卫：公开路由直接放行；未登录跳登录（带 redirect）；按路由元数据校验权限 */
export default function AuthGuard({ children }: { children: ReactNode }) {
  const location = useLocation()
  const initializing = useAuthStore(s => s.initializing)
  const admin = useAuthStore(s => s.admin)
  const permissions = useAuthStore(s => s.permissions)
  const restore = useAuthStore(s => s.restore)

  useEffect(() => {
    void restore()
  }, [restore])

  useEffect(() => {
    if (!initializing) hideLoading()
  }, [initializing])

  const meta = getRouteMeta(location.pathname)

  if (initializing) return null
  if (meta?.public) return <>{children}</>

  if (!admin) {
    const target = location.pathname + location.search
    return <Navigate to={`/login?redirect=${encodeURIComponent(target)}`} replace />
  }

  if (meta?.anyOf && meta.anyOf.length > 0 && !meta.anyOf.some(p => permissions.includes(p))) {
    return <Navigate to="/exception/403" replace />
  }

  return <>{children}</>
}

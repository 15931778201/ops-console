import { create } from 'zustand'

import type { AdminView } from '@/lib/api-client'

import { clearTokens, getAccessToken, hasSession, setSessionLostHandler } from '@/lib/api-client'
import { adminAuthApi } from '@/lib/auth-api'

/** 空闲自动登出阈值（设计文档 7.3：30 分钟） */
const IDLE_LOGOUT_MS = 30 * 60 * 1000

interface AuthState {
  admin: AdminView | null
  permissions: string[]
  /** 首次会话恢复中 */
  initializing: boolean
  has: (code: string) => boolean
  hasAny: (codes: string[]) => boolean
  /** 首屏恢复：有令牌就拉 /auth/me */
  restore: () => Promise<void>
  /** 登录完成后拉取会话信息 */
  loadMe: () => Promise<void>
  logout: () => Promise<void>
}

let idleTimer: number | null = null
let idleWatching = false

export const useAuthStore = create<AuthState>()((set, get) => {
  const clearSession = (): void => {
    clearTokens()
    set({ admin: null, permissions: [] })
  }

  const resetIdle = (): void => {
    if (idleTimer !== null) window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(clearSession, IDLE_LOGOUT_MS)
  }

  const startIdleWatch = (): void => {
    if (!idleWatching) {
      idleWatching = true
      for (const e of ['mousemove', 'keydown', 'click', 'touchstart'] as const) {
        window.addEventListener(e, resetIdle, { passive: true })
      }
    }
    resetIdle()
  }

  // 会话失效（刷新令牌失败）→ 清状态，由路由守卫跳登录
  setSessionLostHandler(() => set({ admin: null, permissions: [] }))

  return {
    admin: null,
    permissions: [],
    initializing: true,
    has: code => get().permissions.includes(code),
    hasAny: codes => codes.length === 0 || codes.some(c => get().permissions.includes(c)),
    restore: async () => {
      if (!hasSession() && !getAccessToken()) {
        set({ initializing: false })
        return
      }
      try {
        const me = await adminAuthApi.me()
        set({ admin: me.admin, permissions: me.permissions })
        startIdleWatch()
      }
      catch {
        clearSession()
      }
      finally {
        set({ initializing: false })
      }
    },
    loadMe: async () => {
      const me = await adminAuthApi.me()
      set({ admin: me.admin, permissions: me.permissions })
      startIdleWatch()
    },
    logout: async () => {
      try {
        await adminAuthApi.logout()
      }
      catch {
        /* 网络失败也要清本地会话 */
      }
      clearSession()
      if (idleTimer !== null) window.clearTimeout(idleTimer)
    },
  }
})

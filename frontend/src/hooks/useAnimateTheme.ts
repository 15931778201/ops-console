import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'

import { useTransitionControl } from '@/contexts'
import { useAppStore } from '@/stores/appStore'

const isBrowser = typeof window !== 'undefined'

// 注入基础样式
function injectBaseStyles() {
  if (isBrowser) {
    const styleId = 'theme-switch-base-style'
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = `
        html.stop-transition * {
          transition: none !important;
        }
        ::view-transition-old(root),
        ::view-transition-new(root) {
          animation: none;
          mix-blend-mode: normal;
        }
        ::view-transition-old(root),
        .dark::view-transition-new(root) {
          z-index: 1;
        }
        ::view-transition-new(root),
        .dark::view-transition-old(root) {
          z-index: 9999;
        }
      `
      document.head.appendChild(style)
    }
  }
}

export interface UseAnimateThemeOptions {
  duration?: number
  easing?: string
}

export function useAnimateTheme(options: UseAnimateThemeOptions = {}) {
  const {
    duration = 800,
    easing = 'ease-in-out',
  } = options

  const { isDark, toggleTheme } = useAppStore(
    useShallow(state => ({
      isDark: state.isDark,
      toggleTheme: state.toggleTheme,
    })),
  )

  const { disableRouteTransitions, enableRouteTransitions } = useTransitionControl()

  const [isLoading, setIsLoading] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // 当钩子初始化时注入基础样式
  useEffect(() => {
    injectBaseStyles()
  }, [])

  const animateToggleTheme = useCallback(async () => {
    if (isLoading)
      return

    setIsLoading(true)

    if (
      !triggerRef.current
      || !(document as any).startViewTransition
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      toggleTheme()
      setIsLoading(false)
      return
    }

    // 禁用路由过渡
    disableRouteTransitions()

    const { top, left, width, height } = triggerRef.current.getBoundingClientRect()
    const x = left + width / 2
    const y = top + height / 2

    const clipPath = [
      `circle(0px at ${x}px ${y}px)`,
      `circle(${Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))}px at ${x}px ${y}px)`,
    ]

    document.documentElement.classList.add('stop-transition')

    try {
      await document.startViewTransition(async () => {
        flushSync(() => {
          toggleTheme()
        })
      }).ready

      const animation = document.documentElement.animate(
        {
          clipPath: isDark ? clipPath : clipPath.reverse(),
        },
        {
          duration,
          easing,
          pseudoElement: `::view-transition-${isDark ? 'new' : 'old'}(root)`,
        },
      )

      // 清理函数
      const cleanup = () => {
        document.documentElement.classList.remove('stop-transition')
        document.documentElement.style.viewTransitionName = ''

        // 重新启用路由过渡
        enableRouteTransitions()

        setIsLoading(false)
      }

      animation.addEventListener('finish', cleanup, { once: true })
      animation.addEventListener('cancel', cleanup, { once: true })
    }
    catch (error) {
      console.error('主题切换动画出错:', error)
      document.documentElement.classList.remove('stop-transition')
      document.documentElement.style.viewTransitionName = ''

      enableRouteTransitions()

      setIsLoading(false)
      // 回退到常规切换
      toggleTheme()
    }
  }, [isDark, isLoading, duration, easing, toggleTheme, disableRouteTransitions, enableRouteTransitions])

  return {
    triggerRef,
    isDark,
    isLoading,
    toggleTheme,
    animateToggleTheme,
  }
}

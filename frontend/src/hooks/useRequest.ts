import { useCallback, useEffect, useRef, useState } from 'react'

import { errText } from '@/components/page'

/**
 * 轻量请求 Hook：deps 变化自动重新请求；忽略过期响应；暴露 reload / setData。
 */
export function useRequest<T>(fn: () => Promise<T>, deps: unknown[], fallbackMsg = '加载失败') {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const reload = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const r = await fnRef.current()
      if (id === seq.current) setData(r)
    }
    catch (e) {
      if (id === seq.current) setError(errText(e, fallbackMsg))
    }
    finally {
      if (id === seq.current) setLoading(false)
    }
  }, [fallbackMsg])

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading, error, reload, setData }
}

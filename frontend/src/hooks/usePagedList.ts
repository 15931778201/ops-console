import type { TablePaginationConfig } from 'antd'

import { useCallback, useEffect, useRef, useState } from 'react'

import { errText } from '@/components/page'

export interface PagedResult<T> {
  items: T[]
  pagination: { page: number, pageSize: number, total: number, totalPages?: number }
}

/**
 * 分页列表 Hook：filters 变化回到第 1 页；暴露给 antd Table 的 pagination 配置。
 * fetcher 返回的额外字段（如 summary、groupCounts）原样保留在 data 上。
 */
export function usePagedList<T, F extends object, R extends PagedResult<T> = PagedResult<T>>(
  fetcher: (q: { page: number, pageSize: number } & F) => Promise<R>,
  initialFilters: F,
  pageSize = 20,
) {
  const [filters, setFiltersState] = useState<F>(initialFilters)
  const [page, setPage] = useState(1)
  const [data, setData] = useState<R | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const reload = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const r = await fetcherRef.current({ page, pageSize, ...filters })
      if (id === seq.current) setData(r)
    }
    catch (e) {
      if (id === seq.current) setError(errText(e, '加载失败'))
    }
    finally {
      if (id === seq.current) setLoading(false)
    }
  }, [page, pageSize, filters])

  useEffect(() => {
    void reload()
  }, [reload])

  const setFilters = useCallback((f: F) => {
    setPage(1)
    setFiltersState(f)
  }, [])

  const pagination: TablePaginationConfig = {
    current: data?.pagination.page ?? page,
    pageSize,
    total: data?.pagination.total ?? 0,
    showSizeChanger: false,
    showTotal: t => `共 ${t} 条`,
    onChange: p => setPage(p),
  }

  return { data, items: data?.items ?? [], loading, error, filters, setFilters, reload, pagination }
}

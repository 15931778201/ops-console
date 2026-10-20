/**
 * 产品作用域：产品由路由 :pid（详情页）或 ?pid=（列表页）指定。
 * 列表页顶部渲染「产品」筛选下拉；详情页只显示产品名。children 在产品就绪后渲染。
 */

import type { ReactNode } from 'react'

import { Alert, Select, Space, Tag } from 'antd'
import { useParams, useSearchParams } from 'react-router-dom'

import { EmptyState, ErrorAlert, Loading } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { USE_MOCK, productApi, type Product, type ProductStatus } from '@/lib/product-api'

const STATUS: Record<ProductStatus, [string, string]> = {
  ONLINE: ['已上线', 'success'],
  DRAFT: ['草稿', 'warning'],
  OFFLINE: ['已下线', 'default'],
}

export function ProductStatusTag({ status }: { status: ProductStatus }) {
  const [label, color] = STATUS[status]
  return <Tag color={color}>{label}</Tag>
}

export function MockNotice() {
  return USE_MOCK
    ? <Alert type="info" showIcon className="!mb-3" message="当前为本地模拟数据（后端产品接口未就绪），刷新页面后重置。设置 VITE_PRODUCT_MOCK=false 切换真实接口。" />
    : null
}

export function ProductScope({ children }: { children: (p: Product) => ReactNode }) {
  const { pid: routePid } = useParams()
  const [params, setParams] = useSearchParams()
  const { data: products, error } = useRequest(() => productApi.list(), [], '加载产品失败')

  if (error) return <div className="m-2"><ErrorAlert error={error} /></div>
  if (!products) return <Loading />
  if (products.length === 0) return <div className="m-2"><EmptyState text="暂无产品，请先在「产品管理」创建" /></div>

  const wanted = routePid ?? params.get('pid')
  const current = products.find(p => p.id === wanted) ?? (routePid ? undefined : products[0])
  if (!current) return <div className="m-2"><ErrorAlert error="产品不存在" /></div>

  return (
    <div className="m-2 flex flex-col gap-2">
      <MockNotice />
      <Space className="rounded bg-white p-3 dark:bg-[#141414]">
        <span className="opacity-60">产品</span>
        {routePid
          ? <b>{current.name}（{current.code}）</b>
          : <Select className="!w-64" value={current.id} onChange={v => setParams({ pid: v }, { replace: true })} options={products.map(p => ({ value: p.id, label: `${p.name}（${p.code}）` }))} />}
        <ProductStatusTag status={current.status} />
      </Space>
      {/* key 保证切换产品时子页面状态重置 */}
      <div key={current.id} className="flex flex-col gap-2">{children(current)}</div>
    </div>
  )
}

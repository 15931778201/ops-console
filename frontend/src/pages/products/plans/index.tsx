/**
 * 产品套餐列表（/products/plans?pid=）；新增 /products/plans/new；编辑 /products/plans/:pid/:planId。
 * 账户级套餐与计费规则见「套餐与规则」。
 */

import { App, Button, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Section, errText, yuan } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product, type ProductPlan } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { ProductScope } from '../components/scope'

function PlansView({ product }: { product: Product }) {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [toggling, setToggling] = useState<ProductPlan | null>(null)
  const { data, loading, error, reload } = useRequest(() => productApi.plans(product.id), [product.id], '加载套餐失败')

  return (
    <Section title="产品套餐" extra={canWrite && <Link to={`/products/plans/new?pid=${product.id}`}><Button type="primary">新增套餐</Button></Link>}>
      <div className="mb-3 text-sm opacity-70">本页配置产品维度的售卖套餐；账户级套餐与计费规则见「套餐与规则」。</div>
      <ErrorAlert error={error} />
      <Table<ProductPlan>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        pagination={false}
        locale={{ emptyText: '该产品暂无套餐' }}
        columns={[
          { title: '套餐', dataIndex: 'name' },
          { title: '周期', dataIndex: 'periodMonths', render: v => `${v} 个月` },
          { title: '价格', dataIndex: 'priceCents', render: yuan },
          { title: '月积分', dataIndex: 'monthlyCredits' },
          { title: '权益', dataIndex: 'features', ellipsis: true, render: (f: string[]) => f.join(' / ') },
          { title: '状态', dataIndex: 'active', render: v => (v ? <Tag color="success">在售</Tag> : <Tag>已下架</Tag>) },
          {
            title: '操作',
            render: (_, p) => canWrite && (
              <Space size="small">
                <Link to={`/products/plans/${product.id}/${p.id}`}><Button size="small">编辑</Button></Link>
                <Button size="small" danger={p.active} onClick={() => setToggling(p)}>{p.active ? '下架' : '上架'}</Button>
              </Space>
            ),
          },
        ]}
      />
      <ConfirmModal
        open={!!toggling}
        danger={toggling?.active}
        title={`${toggling?.active ? '下架' : '上架'}套餐 · ${toggling?.name}`}
        content={<p>{toggling?.active ? '下架后不可再下新订单，存量用户不受影响。' : '上架后用户端恢复展示。'}</p>}
        onCancel={() => setToggling(null)}
        onOk={async () => {
          const p = toggling!
          try {
            await productApi.togglePlan(product.id, p.id, !p.active)
            message.success(`${p.name} 已${p.active ? '下架' : '上架'}`)
            await reload()
          }
          catch (e) {
            message.error(errText(e, '操作失败'))
          }
          setToggling(null)
        }}
      />
    </Section>
  )
}

export default function ProductPlansPage() {
  return <ProductScope>{p => <PlansView product={p} />}</ProductScope>
}

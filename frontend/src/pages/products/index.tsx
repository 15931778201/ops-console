/**
 * 产品列表（/products）；新建 /products/new；详情 /products/:id；编辑 /products/:id/edit。
 * 产品是套餐、版本、评价的归属主体；创建后为草稿，需在上线配置中发布。权限：读 plan:read，写 plan:write。
 */

import { App, Button, Space, Table } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, PageCard, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { MockNotice, ProductStatusTag } from './components/scope'

export default function ProductListPage() {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [deleting, setDeleting] = useState<Product | null>(null)
  const { data, loading, error, reload } = useRequest(() => productApi.list(), [], '加载产品失败')

  return (
    <PageCard title="产品管理" extra={canWrite && <Link to="/products/new"><Button type="primary">新建产品</Button></Link>}>
      <MockNotice />
      <div className="mb-3 text-sm opacity-70">产品是套餐、版本、评价的归属主体；创建后为草稿，需在上线配置中发布。</div>
      <ErrorAlert error={error} />
      <Table<Product>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        pagination={false}
        locale={{ emptyText: '暂无产品' }}
        columns={[
          { title: '产品', render: (_, p) => (<div>{p.name}<div className="font-mono text-xs opacity-60">{p.code}</div></div>) },
          { title: '分类', dataIndex: 'category' },
          { title: '状态', dataIndex: 'status', render: s => <ProductStatusTag status={s} /> },
          { title: '更新时间', dataIndex: 'updatedAt', render: fmtTime },
          {
            title: '操作',
            render: (_, p) => (
              <Space size="small">
                <Link to={`/products/${p.id}`}><Button size="small">详情</Button></Link>
                {canWrite && (
                  <>
                    <Link to={`/products/${p.id}/edit`}><Button size="small">编辑</Button></Link>
                    <Button size="small" danger disabled={p.status === 'ONLINE'} onClick={() => setDeleting(p)}>删除</Button>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      <ConfirmModal
        open={!!deleting}
        danger
        title={`删除产品 · ${deleting?.name}`}
        okText="确认删除"
        verifyText={deleting?.code}
        content={<p>将永久删除该产品及其配置，不可恢复。</p>}
        onCancel={() => setDeleting(null)}
        onOk={async () => {
          const p = deleting!
          try {
            await productApi.remove(p.id)
            message.success(`已删除 ${p.name}`)
            await reload()
          }
          catch (e) {
            message.error(errText(e, '删除失败'))
          }
          setDeleting(null)
        }}
      />
    </PageCard>
  )
}

/**
 * 产品评价列表（/products/reviews?pid=）；详情（回复/隐藏）见 /products/reviews/:pid/:rid。
 */

import { App, Button, Rate, Select, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ErrorAlert, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product, type ProductReview } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { ProductScope } from '../components/scope'

function ReviewsView({ product }: { product: Product }) {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [status, setStatus] = useState<string>()
  const [rating, setRating] = useState<number>()
  const { data, loading, error, reload } = useRequest(() => productApi.reviews(product.id, { status: status || undefined, rating: rating || undefined }), [product.id, status, rating], '加载评价失败')

  const toggle = async (r: ProductReview): Promise<void> => {
    try {
      await productApi.setReviewStatus(product.id, r.id, r.status === 'VISIBLE' ? 'HIDDEN' : 'VISIBLE')
      message.success(r.status === 'VISIBLE' ? '评价已隐藏' : '评价已恢复展示')
      await reload()
    }
    catch (e) {
      message.error(errText(e, '操作失败'))
    }
  }

  return (
    <Section title="用户评价">
      <ErrorAlert error={error} />
      <Space className="!mb-3">
        <Select allowClear placeholder="全部状态" className="!w-32" value={status} onChange={setStatus} options={[{ value: 'VISIBLE', label: '展示中' }, { value: 'HIDDEN', label: '已隐藏' }]} />
        <Select allowClear placeholder="全部评分" className="!w-32" value={rating} onChange={setRating} options={[5, 4, 3, 2, 1].map(n => ({ value: n, label: `${n} 星` }))} />
      </Space>
      <Table<ProductReview>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '暂无评价' }}
        columns={[
          { title: '用户', dataIndex: 'userEmail' },
          { title: '评分', dataIndex: 'rating', render: v => <Rate disabled value={v} /> },
          { title: '内容', dataIndex: 'content', ellipsis: true },
          { title: '版本', dataIndex: 'version', render: v => <span className="font-mono">{v}</span> },
          { title: '官方回复', dataIndex: 'reply', ellipsis: true, render: v => v || '-' },
          { title: '状态', dataIndex: 'status', render: s => (s === 'VISIBLE' ? <Tag color="success">展示中</Tag> : <Tag>已隐藏</Tag>) },
          { title: '时间', dataIndex: 'createdAt', render: fmtTime },
          {
            title: '操作',
            fixed: 'right',
            render: (_, r) => (
              <Space size="small">
                <Link to={`/products/reviews/${product.id}/${r.id}`}><Button size="small">详情</Button></Link>
                {canWrite && <Button size="small" onClick={() => void toggle(r)}>{r.status === 'VISIBLE' ? '隐藏' : '恢复'}</Button>}
              </Space>
            ),
          },
        ]}
      />
    </Section>
  )
}

export default function ProductReviewsPage() {
  return <ProductScope>{p => <ReviewsView product={p} />}</ProductScope>
}

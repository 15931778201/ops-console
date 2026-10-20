/**
 * 产品版本列表（/products/versions?pid=）；发布 /products/versions/new；详情 /products/versions/:pid/:vid。
 * 撤回版本后客户端不再检测到该更新，已安装用户不受影响。
 */

import { App, Button, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Section, errText, fmtTime } from '@/components/page'
import { htmlToText } from '@/components/rich-text'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product, type ProductVersion } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { ProductScope } from '../components/scope'

function VersionsView({ product }: { product: Product }) {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [withdrawing, setWithdrawing] = useState<ProductVersion | null>(null)
  const { data, loading, error, reload } = useRequest(() => productApi.versions(product.id), [product.id], '加载版本失败')

  return (
    <Section title="版本列表" extra={canWrite && <Link to={`/products/versions/new?pid=${product.id}`}><Button type="primary">发布新版本</Button></Link>}>
      <div className="mb-3 text-sm opacity-70">撤回版本后客户端不再检测到该更新，已安装用户不受影响。</div>
      <ErrorAlert error={error} />
      <Table<ProductVersion>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '暂无版本' }}
        columns={[
          { title: '版本', dataIndex: 'version', render: v => <span className="font-mono">{v}</span> },
          { title: '平台', dataIndex: 'platform' },
          { title: '渠道', dataIndex: 'channel', render: c => <Tag color={c === 'stable' ? 'processing' : 'warning'}>{c}</Tag> },
          { title: '更新内容', dataIndex: 'changelog', ellipsis: true, render: htmlToText },
          { title: '强制更新', render: (_, v) => (v.forceUpdate ? `是（<${v.minSupported || '-'} 强更）` : '否') },
          { title: '状态', dataIndex: 'status', render: s => (s === 'PUBLISHED' ? <Tag color="success">已发布</Tag> : <Tag>已撤回</Tag>) },
          { title: '发布时间', dataIndex: 'publishedAt', render: fmtTime },
          {
            title: '操作',
            fixed: 'right',
            render: (_, v) => (
              <Space size="small">
                <Link to={`/products/versions/${product.id}/${v.id}`}><Button size="small">详情</Button></Link>
                {canWrite && v.status === 'PUBLISHED' && <Button size="small" danger onClick={() => setWithdrawing(v)}>撤回</Button>}
              </Space>
            ),
          },
        ]}
      />
      <ConfirmModal
        open={!!withdrawing}
        danger
        title={`撤回版本 · ${withdrawing?.version}`}
        okText="确认撤回"
        content={<p>撤回 {withdrawing?.platform}/{withdrawing?.channel} 的 {withdrawing?.version}？</p>}
        onCancel={() => setWithdrawing(null)}
        onOk={async () => {
          const v = withdrawing!
          try {
            await productApi.withdrawVersion(product.id, v.id)
            message.success(`已撤回 ${v.version}`)
            await reload()
          }
          catch (e) {
            message.error(errText(e, '撤回失败'))
          }
          setWithdrawing(null)
        }}
      />
    </Section>
  )
}

export default function ProductVersionsPage() {
  return <ProductScope>{p => <VersionsView product={p} />}</ProductScope>
}

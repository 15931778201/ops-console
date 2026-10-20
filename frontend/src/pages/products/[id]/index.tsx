/**
 * 产品详情（/products/:id）：只读信息；编辑走独立表单页；六个按钮带上当前产品跳到各子模块列表页。
 */

import { Button, Descriptions, Space } from 'antd'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, PageCard, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { MockNotice, ProductStatusTag } from '../components/scope'

const SUBS: Array<[string, string]> = [['release', '上线配置'], ['versions', '版本管理'], ['analytics', '数据分析'], ['plans', '产品套餐'], ['i18n', '多语言配置'], ['reviews', '评价列表']]

export default function ProductDetailPage() {
  const { id } = useParams()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const { data: p, loading, error } = useRequest(async () => {
    const hit = (await productApi.list()).find(x => x.id === id)
    if (!hit) throw new Error('产品不存在')
    return hit
  }, [id], '加载产品失败')

  if (loading && !p) return <Loading />
  if (!p) return <div className="m-2"><ErrorAlert error={error ?? '产品不存在'} /></div>

  return (
    <PageCard
      title={`产品详情 · ${p.name}`}
      extra={(
        <Space>
          <Link to="/products"><Button>返回列表</Button></Link>
          {canWrite && <Link to={`/products/${p.id}/edit`}><Button type="primary">编辑</Button></Link>}
        </Space>
      )}
    >
      <MockNotice />
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="名称">{p.name}</Descriptions.Item>
        <Descriptions.Item label="编码"><span className="font-mono">{p.code}</span></Descriptions.Item>
        <Descriptions.Item label="分类">{p.category}</Descriptions.Item>
        <Descriptions.Item label="状态"><ProductStatusTag status={p.status} /></Descriptions.Item>
        <Descriptions.Item label="简介" span={2}>{p.description || '-'}</Descriptions.Item>
        <Descriptions.Item label="创建时间">{fmtTime(p.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="更新时间">{fmtTime(p.updatedAt)}</Descriptions.Item>
      </Descriptions>
      <Space className="!mt-4" wrap>
        {SUBS.map(([t, label]) => <Link key={t} to={`/products/${t}?pid=${p.id}`}><Button size="small">{label}</Button></Link>)}
      </Space>
    </PageCard>
  )
}

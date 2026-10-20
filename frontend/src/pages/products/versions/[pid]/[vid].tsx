/**
 * 版本详情（/products/versions/:pid/:vid）。
 */

import { Button, Descriptions, Tag } from 'antd'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, Section, fmtTime } from '@/components/page'
import { RichTextView } from '@/components/rich-text'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product } from '@/lib/product-api'

import { ProductScope } from '../../components/scope'

function VersionDetail({ product }: { product: Product }) {
  const { vid } = useParams()
  const { data: v, loading, error } = useRequest(async () => {
    const hit = (await productApi.versions(product.id)).find(x => x.id === vid)
    if (!hit) throw new Error('版本不存在')
    return hit
  }, [product.id, vid], '加载版本失败')

  if (loading && !v) return <Loading />
  if (!v) return <ErrorAlert error={error} />

  return (
    <Section title={`版本详情 · ${v.version}`} extra={<Link to={`/products/versions?pid=${product.id}`}><Button>返回列表</Button></Link>}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="版本号"><span className="font-mono">{v.version}</span></Descriptions.Item>
        <Descriptions.Item label="平台 / 渠道">{v.platform} / {v.channel}</Descriptions.Item>
        <Descriptions.Item label="状态">{v.status === 'PUBLISHED' ? <Tag color="success">已发布</Tag> : <Tag>已撤回</Tag>}</Descriptions.Item>
        <Descriptions.Item label="强制更新">{v.forceUpdate ? `是（低于 ${v.minSupported || '-'} 强更）` : '否'}</Descriptions.Item>
        <Descriptions.Item label="下载地址" span={2}><span className="font-mono">{v.downloadUrl}</span></Descriptions.Item>
        <Descriptions.Item label="发布时间">{fmtTime(v.publishedAt)}</Descriptions.Item>
      </Descriptions>
      <h4 className="mb-2 mt-4">更新内容</h4>
      <RichTextView html={v.changelog} />
    </Section>
  )
}

export default function VersionDetailPage() {
  return <ProductScope>{p => <VersionDetail product={p} />}</ProductScope>
}

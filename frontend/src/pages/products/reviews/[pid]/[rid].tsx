/**
 * 评价详情（/products/reviews/:pid/:rid）：查看全文、官方回复、隐藏/恢复。
 */

import { App, Button, Descriptions, Form, Input, Rate, Space, Tag } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { ProductScope } from '../../components/scope'

function ReviewDetail({ product }: { product: Product }) {
  const { rid } = useParams()
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [form] = Form.useForm<{ reply: string }>()
  const [busy, setBusy] = useState(false)
  const { data: r, loading, error, reload } = useRequest(async () => {
    const hit = (await productApi.reviews(product.id, {})).find(x => x.id === rid)
    if (!hit) throw new Error('评价不存在')
    form.setFieldsValue({ reply: hit.reply })
    return hit
  }, [product.id, rid], '加载评价失败')

  if (loading && !r) return <Loading />
  if (!r) return <ErrorAlert error={error} />

  return (
    <Section title="评价详情" extra={<Link to={`/products/reviews?pid=${product.id}`}><Button>返回列表</Button></Link>}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="用户">{r.userEmail}</Descriptions.Item>
        <Descriptions.Item label="评分"><Rate disabled value={r.rating} /></Descriptions.Item>
        <Descriptions.Item label="版本"><span className="font-mono">{r.version}</span></Descriptions.Item>
        <Descriptions.Item label="时间">{fmtTime(r.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="状态">{r.status === 'VISIBLE' ? <Tag color="success">展示中</Tag> : <Tag>已隐藏</Tag>}</Descriptions.Item>
        <Descriptions.Item label="内容" span={2}>{r.content}</Descriptions.Item>
      </Descriptions>
      {canWrite
        ? (
            <Form
              form={form}
              layout="vertical"
              className="!mt-4 max-w-2xl"
              onFinish={async (v) => {
                setBusy(true)
                try {
                  await productApi.replyReview(product.id, r.id, v.reply.trim())
                  message.success('回复已保存')
                  await reload()
                }
                catch (e) {
                  message.error(errText(e, '回复失败'))
                }
                finally {
                  setBusy(false)
                }
              }}
            >
              <Form.Item name="reply" label="官方回复"><Input.TextArea rows={3} /></Form.Item>
              <Space>
                <Button type="primary" htmlType="submit" loading={busy}>保存回复</Button>
                <Button onClick={async () => {
                  try {
                    await productApi.setReviewStatus(product.id, r.id, r.status === 'VISIBLE' ? 'HIDDEN' : 'VISIBLE')
                    message.success(r.status === 'VISIBLE' ? '评价已隐藏' : '评价已恢复展示')
                    await reload()
                  }
                  catch (e) {
                    message.error(errText(e, '操作失败'))
                  }
                }}
                >
                  {r.status === 'VISIBLE' ? '隐藏评价' : '恢复展示'}
                </Button>
              </Space>
            </Form>
          )
        : <p className="mt-4 opacity-70">官方回复：{r.reply || '-'}</p>}
    </Section>
  )
}

export default function ReviewDetailPage() {
  return <ProductScope>{p => <ReviewDetail product={p} />}</ProductScope>
}

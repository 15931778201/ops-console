/**
 * 订单详情（/orders/:orderNo）：基本信息、支付事件时间线、权益发放流水；渠道查单（order:sync）。
 */

import { Alert, Button, Descriptions, Empty, Space, Statistic, Table, Tag } from 'antd'
import { useState } from 'react'
import { App } from 'antd'
import { Link, useParams } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Loading, OrderStatusTag, PageStack, Section, errText, fmtTime, yuan } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { api } from '@/lib/api-client'
import { useAuthStore } from '@/stores/authStore'

import type { OrderDetail, PaymentEvent } from './index'

export default function OrderDetailPage() {
  const { orderNo = '' } = useParams()
  const { message } = App.useApp()
  const has = useAuthStore(s => s.has)
  const [confirm, setConfirm] = useState(false)
  const [notice, setNotice] = useState('')
  const { data, loading, error, reload } = useRequest(() => api.get<OrderDetail>(`/orders/${encodeURIComponent(orderNo)}`), [orderNo], '加载订单失败')

  if (loading && !data) return <Loading />
  if (!data) return <div className="m-2"><ErrorAlert error={error ?? '订单不存在'} /></div>

  const o = data.order

  const doSync = async (): Promise<void> => {
    try {
      const r = await api.post<{ localStatus: string, channelStatus: string, settled: boolean, note?: string }>(`/orders/${encodeURIComponent(orderNo)}/sync`)
      setNotice([`渠道状态：${r.channelStatus}`, `本地状态：${r.localStatus}`, r.settled ? '已补结算（幂等，不会重复发权益）' : '未触发结算', r.note].filter(Boolean).join(' · '))
      setConfirm(false)
      await reload()
    }
    catch (e) {
      message.error(errText(e, '查单失败'))
      setConfirm(false)
    }
  }

  return (
    <PageStack>
      <Section
        title={`订单 ${o.orderNo}`}
        extra={(
          <Space>
            <Link to="/orders"><Button>返回列表</Button></Link>
            {has('order:sync') && <Button type="primary" onClick={() => setConfirm(true)}>渠道查单</Button>}
          </Space>
        )}
      >
        {notice && <Alert type="info" showIcon message={notice} className="!mb-3" closable />}
        <Space size={48} className="!mb-4">
          <Statistic title="金额" value={yuan(o.amountCents)} />
          <div><div className="text-sm opacity-60">状态</div><div className="pt-2"><OrderStatusTag status={o.status} /></div></div>
        </Space>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="用户">{data.user ? <Link to={`/users/${data.user.id}`}>{data.user.name ?? data.user.email ?? data.user.id}</Link> : '—'}</Descriptions.Item>
          <Descriptions.Item label="套餐">{o.planId} × {o.periodMonths} 个月</Descriptions.Item>
          <Descriptions.Item label="渠道">{o.channel === 'WECHAT' ? '微信支付' : '支付宝'}{o.thirdPartyTradeNo && <span className="font-mono opacity-60">{` · ${o.thirdPartyTradeNo}`}</span>}</Descriptions.Item>
          <Descriptions.Item label="创建时间">{fmtTime(o.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="支付时间">{fmtTime(o.paidAt)}</Descriptions.Item>
          <Descriptions.Item label="支付过期">{fmtTime(o.expiresAt)}</Descriptions.Item>
          <Descriptions.Item label="退款时间">{fmtTime(o.refundedAt)}</Descriptions.Item>
        </Descriptions>
      </Section>

      <Section title="支付事件时间线">
        <div className="mb-2 text-xs opacity-60">验签失败或处理失败的事件会在此留痕，便于排查用户投诉。</div>
        <Table<PaymentEvent>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={data.events}
          locale={{ emptyText: '暂无支付事件' }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', render: fmtTime },
            { title: '渠道', dataIndex: 'provider' },
            { title: '事件类型', dataIndex: 'eventType', render: v => <span className="font-mono">{v}</span> },
            { title: '验签', dataIndex: 'signatureValid', render: v => (v ? <Tag color="success">通过</Tag> : <Tag color="error">失败</Tag>) },
            { title: '处理', dataIndex: 'processed', render: v => (v ? <Tag color="success">已处理</Tag> : <Tag color="warning">待处理</Tag>) },
            { title: '错误', dataIndex: 'processError', render: v => v ?? '—' },
          ]}
        />
      </Section>

      <Section title="权益发放流水">
        {!data.grantTransaction
          ? <Empty description="尚未发放权益（订单未支付或额度为 0）" />
          : (
              <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
                <Descriptions.Item label="流水类型">{data.grantTransaction.type}</Descriptions.Item>
                <Descriptions.Item label="发放积分">{data.grantTransaction.amount}</Descriptions.Item>
                <Descriptions.Item label="发放后总额">{data.grantTransaction.balanceAfter}</Descriptions.Item>
                <Descriptions.Item label="时间">{fmtTime(data.grantTransaction.createdAt)}</Descriptions.Item>
              </Descriptions>
            )}
      </Section>

      <ConfirmModal
        open={confirm}
        title="渠道查单"
        content={<p>将向支付渠道查询该订单的真实状态。若渠道已付而本地未结，会自动补结算并发放权益；<b>补结算是幂等的，不会重复发放</b>。金额不一致时不会自动改金额，只做提示。</p>}
        onCancel={() => setConfirm(false)}
        onOk={doSync}
      />
    </PageStack>
  )
}

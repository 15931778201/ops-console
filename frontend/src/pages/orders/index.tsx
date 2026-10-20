/**
 * 订单列表（/orders）；详情见 /orders/:orderNo。权限：order:read。
 */

import { Button, Card, Col, Form, Input, Row, Select, Space, Statistic, Table } from 'antd'
import { Link } from 'react-router-dom'

import { ErrorAlert, OrderStatusTag, PageCard, fmtTime, yuan } from '@/components/page'
import { usePagedList, type PagedResult } from '@/hooks/usePagedList'
import { api } from '@/lib/api-client'

export interface AdminOrderItem {
  orderNo: string
  userId: string
  user: { id: string, email: string | null, phone: string | null, name: string | null } | null
  planId: string
  amountCents: number
  currency: string
  periodMonths: number
  channel: string
  status: string
  creditsGranted: number
  thirdPartyTradeNo: string | null
  paidAt: string | null
  expiresAt: string | null
  refundedAt: string | null
  createdAt: string
}

export interface PaymentEvent {
  id: string
  provider: string
  eventType: string
  signatureValid: boolean
  processed: boolean
  processError: string | null
  createdAt: string
}

export interface OrderDetail {
  order: AdminOrderItem & { priceSnapshot?: unknown }
  user: { id: string, email: string | null, phone: string | null, name: string | null, planId: string, status: string } | null
  events: PaymentEvent[]
  grantTransaction: { id: string, type: string, status: string, amount: number, deltaBalance: number, deltaBonus: number, balanceAfter: number, createdAt: string } | null
}

interface OrderList extends PagedResult<AdminOrderItem> {
  summary: { totalAmountCents: number, paidCount: number }
}
interface Filters { orderNo?: string, status?: string, channel?: string }

export default function OrdersPage() {
  const [form] = Form.useForm<Filters>()
  const list = usePagedList<AdminOrderItem, Filters, OrderList>(
    q => api.get<OrderList>('/orders', { page: q.page, pageSize: q.pageSize, orderNo: q.orderNo?.trim() || undefined, status: q.status || undefined, channel: q.channel || undefined }),
    {},
  )

  return (
    <PageCard title="订单管理">
      <ErrorAlert error={list.error} />
      <Form form={form} layout="inline" className="!mb-4" onFinish={v => list.setFilters(v)}>
        <Form.Item name="orderNo" label="订单号"><Input allowClear placeholder="支持前缀模糊" /></Form.Item>
        <Form.Item name="status" label="状态">
          <Select allowClear placeholder="全部" className="!w-28" options={[['PENDING', '待支付'], ['PAID', '已支付'], ['FAILED', '失败'], ['REFUNDING', '退款中'], ['REFUNDED', '已退款'], ['CLOSED', '已关闭']].map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <Form.Item name="channel" label="渠道">
          <Select allowClear placeholder="全部" className="!w-28" options={[{ value: 'WECHAT', label: '微信' }, { value: 'ALIPAY', label: '支付宝' }]} />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">查询</Button>
          <Button onClick={() => { form.resetFields(); list.setFilters({}) }}>重置</Button>
        </Space>
      </Form>

      {list.data && (
        <Row gutter={12} className="!mb-4">
          <Col xs={12} md={6}><Card size="small"><Statistic title="已支付订单数" value={list.data.summary.paidCount} /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="已支付金额合计" value={yuan(list.data.summary.totalAmountCents)} /></Card></Col>
        </Row>
      )}

      <Table<AdminOrderItem>
        rowKey="orderNo"
        loading={list.loading}
        dataSource={list.items}
        pagination={list.pagination}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '订单号', dataIndex: 'orderNo', render: v => <Link to={`/orders/${v}`} className="font-mono">{v}</Link> },
          { title: '用户', render: (_, o) => (<div><div>{o.user?.name ?? '—'}</div><div className="font-mono text-xs opacity-60">{o.user?.email ?? o.user?.phone ?? o.userId}</div></div>) },
          { title: '套餐', render: (_, o) => `${o.planId} × ${o.periodMonths}月` },
          { title: '金额', dataIndex: 'amountCents', render: yuan },
          { title: '渠道', dataIndex: 'channel', render: c => (c === 'WECHAT' ? '微信' : '支付宝') },
          { title: '状态', dataIndex: 'status', render: s => <OrderStatusTag status={s} /> },
          { title: '发放积分', dataIndex: 'creditsGranted', render: v => v || '—' },
          { title: '创建时间', dataIndex: 'createdAt', render: fmtTime },
          { title: '操作', fixed: 'right', render: (_, o) => <Link to={`/orders/${o.orderNo}`}><Button size="small">详情</Button></Link> },
        ]}
      />
    </PageCard>
  )
}

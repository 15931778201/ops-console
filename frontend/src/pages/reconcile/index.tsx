/**
 * 对账工作台列表（/reconcile）；处理见 /reconcile/:id。权限：reconcile:read。
 *
 * 四类差异：PAID_LOCAL_PENDING 渠道已付本地未结（可重试补结算，幂等）/ PAID_LOCAL_UNKNOWN 本地已结渠道无记录（人工核实）/
 * AMOUNT_MISMATCH 金额不一致（交财务，禁止自动改金额）/ DUPLICATE_NOTIFY 重复回调（已幂等拦截，仅留痕）。
 */

import { Button, Card, Col, Form, Input, Row, Select, Space, Statistic, Table, Tag } from 'antd'
import { Link } from 'react-router-dom'

import { ErrorAlert, PageCard, ReconActionTag, fmtTime } from '@/components/page'
import { usePagedList, type PagedResult } from '@/hooks/usePagedList'
import { api } from '@/lib/api-client'
import { useAuthStore } from '@/stores/authStore'

export const DIFF_LABELS: Record<string, string> = {
  PAID_LOCAL_PENDING: '渠道已付本地未结',
  PAID_LOCAL_UNKNOWN: '本地已结渠道无记录',
  AMOUNT_MISMATCH: '金额不一致',
  DUPLICATE_NOTIFY: '重复回调',
}

export const DIFF_COLORS: Record<string, string> = {
  PAID_LOCAL_PENDING: 'warning',
  PAID_LOCAL_UNKNOWN: 'processing',
  AMOUNT_MISMATCH: 'error',
  DUPLICATE_NOTIFY: 'default',
}

export interface ReconRecord {
  id: string
  channel: string
  orderNo: string
  localStatus: string
  channelStatus: string
  diffType: string
  action: string | null
  note: string | null
  handledBy: string | null
  handledAt: string | null
  createdAt: string
}

export const HANDLE_ACTIONS = [
  { value: 'MANUAL_DONE', label: '已处理完毕' },
  { value: 'ESCALATED', label: '升级处理' },
  { value: 'IGNORED', label: '忽略' },
] as const

interface ReconList extends PagedResult<ReconRecord> { groupCounts: Record<string, number> }
interface Filters { diffType?: string, orderNo?: string, pendingOnly?: boolean }

export default function ReconcilePage() {
  const has = useAuthStore(s => s.has)
  const [form] = Form.useForm<Filters>()
  const list = usePagedList<ReconRecord, Filters, ReconList>(
    q => api.get<ReconList>('/reconciliations', { page: q.page, pageSize: q.pageSize, diffType: q.diffType || undefined, orderNo: q.orderNo?.trim() || undefined, pendingOnly: q.pendingOnly ? 'true' : undefined }),
    { pendingOnly: true },
  )

  return (
    <PageCard title="对账工作台">
      <div className="mb-3 text-sm opacity-70">渠道与本地的状态差异。此处只标记工单状态，不直接改动资金；金额不一致必须交财务人工核实。</div>
      <ErrorAlert error={list.error} />

      {list.data && (
        <Row gutter={[12, 12]} className="!mb-4">
          {Object.keys(DIFF_LABELS).map(k => (
            <Col key={k} xs={12} md={6}>
              <Card size="small" hoverable className={list.filters.diffType === k ? '!border-blue-500' : ''} onClick={() => { const next = list.filters.diffType === k ? undefined : k; form.setFieldValue('diffType', next); list.setFilters({ ...list.filters, diffType: next }) }}>
                <Statistic title={DIFF_LABELS[k]} value={list.data!.groupCounts[k] ?? 0} suffix={list.filters.diffType === k ? <span className="text-xs opacity-60">已筛选</span> : null} />
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Form form={form} layout="inline" className="!mb-4" initialValues={list.filters} onFinish={v => list.setFilters(v)}>
        <Form.Item name="diffType" label="差异类型"><Select allowClear placeholder="全部" className="!w-48" options={Object.entries(DIFF_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <Form.Item name="orderNo" label="订单号"><Input allowClear placeholder="支持模糊" /></Form.Item>
        <Form.Item name="pendingOnly" label="范围"><Select className="!w-44" options={[{ value: true, label: '仅待处理' }, { value: false, label: '全部（含已处理）' }]} /></Form.Item>
        <Space><Button type="primary" htmlType="submit">查询</Button></Space>
      </Form>

      <Table<ReconRecord>
        rowKey="id"
        loading={list.loading}
        dataSource={list.items}
        pagination={list.pagination}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '订单号', dataIndex: 'orderNo', render: v => <Link to={`/orders/${v}`} className="font-mono">{v}</Link> },
          { title: '差异类型', dataIndex: 'diffType', render: v => <Tag color={DIFF_COLORS[v]}>{DIFF_LABELS[v] ?? v}</Tag> },
          { title: '本地 / 渠道', render: (_, r) => <span className="font-mono">{r.localStatus} / {r.channelStatus}</span> },
          { title: '处理状态', dataIndex: 'action', render: a => <ReconActionTag action={a} /> },
          { title: '备注', dataIndex: 'note', render: v => v ?? '—' },
          { title: '发现时间', dataIndex: 'createdAt', render: fmtTime },
          { title: '操作', fixed: 'right', render: (_, r) => <Link to={`/reconcile/${r.id}`}><Button size="small" type={has('reconcile:handle') && r.action === null ? 'primary' : 'default'}>{has('reconcile:handle') && r.action === null ? '处理' : '详情'}</Button></Link> },
        ]}
      />
    </PageCard>
  )
}

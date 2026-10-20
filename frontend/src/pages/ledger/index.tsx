/**
 * 积分账本 · 全局流水（/ledger）。权限：credit:read（本模块全部只读，调账只能走审批中心）。
 * 异常账户见 /ledger/anomalies；账户详情见 /ledger/accounts/:userId。
 */

import { Alert, Button, Card, Col, DatePicker, Form, Input, Row, Select, Space, Statistic, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'

import { ErrorAlert, PageStack, Section, fmtNum, fmtTime } from '@/components/page'
import { usePagedList, type PagedResult } from '@/hooks/usePagedList'
import { ledgerApi, type LedgerEntry, type LedgerListParams, type LedgerMeta, type LedgerSummary } from '@/lib/ledger-api'
import { Link } from 'react-router-dom'

import { LedgerTabs, TXN_STATUS_COLOR, TxnTypeTag, numClass } from './components/shared'

interface TxnList extends PagedResult<LedgerEntry> { summary: LedgerSummary }
type Filters = Omit<LedgerListParams, 'page' | 'pageSize'>

export default function LedgerPage() {
  const [meta, setMeta] = useState<LedgerMeta | null>(null)
  const [form] = Form.useForm()
  const list = usePagedList<LedgerEntry, Filters, TxnList>(q => ledgerApi.transactions(q) as Promise<TxnList>, {})

  useEffect(() => {
    ledgerApi.meta().then(setMeta).catch(() => undefined)
  }, [])

  const s = list.data?.summary

  return (
    <PageStack>
      <Section title="积分账本" extra={<LedgerTabs />}>
        <Alert type="info" showIcon className="!mb-3" message="账本只读：本页不提供任何改余额入口，调账请走审批中心。" />
        <ErrorAlert error={list.error} />
        <Form
          form={form}
          layout="inline"
          className="gap-y-2"
          onFinish={(v) => {
            const [from, to] = (v.range ?? []) as [{ toISOString: () => string }?, { toISOString: () => string }?]
            list.setFilters({ userSearch: v.userSearch, type: v.type, status: v.status, toolSlug: v.toolSlug, reference: v.reference, createdFrom: from?.toISOString(), createdTo: to?.toISOString() })
          }}
        >
          <Form.Item name="userSearch" label="用户"><Input allowClear placeholder="邮箱或昵称" /></Form.Item>
          <Form.Item name="type" label="类型"><Select allowClear placeholder="全部" className="!w-32" options={meta?.types.map(t => ({ value: t.value, label: t.label }))} /></Form.Item>
          <Form.Item name="status" label="状态"><Select allowClear placeholder="全部" className="!w-28" options={meta?.statuses.map(t => ({ value: t.value, label: t.label }))} /></Form.Item>
          <Form.Item name="toolSlug" label="工具"><Input allowClear placeholder="如 pdf-merge" className="!w-36" /></Form.Item>
          <Form.Item name="reference" label="关联 ID"><Input allowClear placeholder="referenceId" className="!w-40" /></Form.Item>
          <Form.Item name="range" label="时间"><DatePicker.RangePicker showTime /></Form.Item>
          <Space><Button type="primary" htmlType="submit">查询</Button><Button onClick={() => { form.resetFields(); list.setFilters({}) }}>重置</Button></Space>
        </Form>
      </Section>

      {s && (
        <Section title="汇总">
          {s.hasRolledBack && <Alert type="warning" showIcon className="!mb-3" message="当前筛选范围内包含已回滚条目，其金额未计入余额重算口径（下方净额含回滚，仅供对账参考）。" />}
          <Row gutter={12}>
            {[['条目数', s.count], ['净变动', s.netAmount], ['订阅积分合计', s.sumDeltaBalance], ['奖励积分合计', s.sumDeltaBonus]].map(([t, v]) => (
              <Col key={t as string} xs={12} md={6}><Card size="small"><Statistic title={t as string} value={fmtNum(v as number)} /></Card></Col>
            ))}
          </Row>
          <div className="mt-3 flex flex-wrap gap-2">{s.byType.map(g => <Tag key={g.type}>{g.label} {fmtNum(g.count)} 条 · 净 {fmtNum(g.netAmount)}</Tag>)}</div>
        </Section>
      )}

      <Section title="流水明细">
        <div className="mb-2 text-xs opacity-60">分账快照：deltaBalance 为订阅积分、deltaBonus 为奖励积分。</div>
        <Table<LedgerEntry>
          rowKey="id"
          size="small"
          loading={list.loading}
          dataSource={list.items}
          pagination={list.pagination}
          scroll={{ x: 'max-content' }}
          rowClassName={r => (r.status === 'ROLLED_BACK' ? 'opacity-50' : '')}
          locale={{ emptyText: '没有符合条件的流水' }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', render: fmtTime },
            { title: '用户', render: (_, t) => <Link to={`/ledger/accounts/${t.userId}`}>{t.userEmail ?? t.userId.slice(0, 8)}</Link> },
            { title: '类型', render: (_, t) => <TxnTypeTag type={t.type} label={t.typeLabel} /> },
            { title: '状态', dataIndex: 'status', render: v => <Tag color={TXN_STATUS_COLOR[v as keyof typeof TXN_STATUS_COLOR]}>{v}</Tag> },
            { title: '净变动', dataIndex: 'amount', render: v => <span className={numClass(v)}>{fmtNum(v)}</span> },
            { title: '订阅', dataIndex: 'deltaBalance', render: fmtNum },
            { title: '奖励', dataIndex: 'deltaBonus', render: fmtNum },
            { title: '变动后余额', render: (_, t) => `${fmtNum(t.balanceAfterBalance)} / ${fmtNum(t.balanceAfterBonus)}` },
            { title: '说明', render: (_, t) => (<div className="max-w-56"><div className="truncate">{t.description ?? '-'}</div>{t.referenceId && <div className="truncate text-xs opacity-60">ref: {t.referenceId}</div>}</div>) },
          ]}
        />
      </Section>
    </PageStack>
  )
}

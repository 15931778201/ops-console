/**
 * 审批中心列表（/approvals）。提交 /approvals/new；详情与批准/拒绝/撤回/重试 /approvals/:id。
 * 列表按"待我审批 / 我提交的 / 全部"分页签；待我审批排除自己提交的单子。
 */

import { Badge, Button, Segmented, Select, Table } from 'antd'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { ErrorAlert, PageCard, fmtTime } from '@/components/page'
import { usePagedList } from '@/hooks/usePagedList'
import { APPROVAL_STATUS_LABELS, APPROVAL_TYPE_LABELS, approvalApi, type ApprovalStatus, type ApprovalView } from '@/lib/approval-api'
import { useAuthStore } from '@/stores/authStore'

import { ApprovalStatusTag, formatPayload } from './components/shared'

type Tab = 'todo' | 'mine' | 'all'
interface Filters { tab: Tab, status?: ApprovalStatus }

export default function ApprovalsPage() {
  const admin = useAuthStore(s => s.admin)
  const has = useAuthStore(s => s.has)
  const [pendingCount, setPendingCount] = useState(0)

  const list = usePagedList<ApprovalView, Filters>(
    q => approvalApi.list({ page: q.page, pageSize: q.pageSize, status: q.status, mine: q.tab === 'todo' ? true : undefined, applicantId: q.tab === 'mine' && admin ? admin.id : undefined }),
    { tab: 'todo' },
  )

  useEffect(() => {
    approvalApi.mineCount().then(r => setPendingCount(r.pendingCount)).catch(() => undefined)
  }, [])

  return (
    <PageCard title="审批中心" extra={has('credit:adjust:apply') && <Link to="/approvals/new"><Button type="primary">提交调账申请</Button></Link>}>
      <div className="mb-3 text-sm opacity-70">资金相关操作必须双人复核：申请 → 审批 → 服务端同事务执行。申请人不能审批或执行自己的单子。</div>
      <ErrorAlert error={list.error} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={list.filters.tab}
          onChange={v => list.setFilters({ ...list.filters, tab: v as Tab })}
          options={[
            { value: 'todo', label: <Badge count={pendingCount} size="small" offset={[10, -2]}>待我审批</Badge> },
            { value: 'mine', label: '我提交的' },
            { value: 'all', label: '全部' },
          ]}
        />
        <Select allowClear placeholder="全部状态" className="!w-36" value={list.filters.status} onChange={v => list.setFilters({ ...list.filters, status: v })} options={Object.entries(APPROVAL_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
      </div>

      <Table<ApprovalView>
        rowKey="id"
        loading={list.loading}
        dataSource={list.items}
        pagination={list.pagination}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '暂无审批单' }}
        columns={[
          { title: '类型', dataIndex: 'type', render: t => APPROVAL_TYPE_LABELS[t as keyof typeof APPROVAL_TYPE_LABELS] },
          { title: '内容', dataIndex: 'payload', render: formatPayload },
          { title: '申请人', dataIndex: 'applicantId', render: v => (<><span className="font-mono">{v.slice(0, 8)}…</span>{admin?.id === v && <span className="opacity-60">（我）</span>}</>) },
          { title: '状态', dataIndex: 'status', render: s => <ApprovalStatusTag status={s} label={APPROVAL_STATUS_LABELS[s as ApprovalStatus]} /> },
          { title: '原因 / 工单', render: (_, r) => (<div className="max-w-56"><div className="truncate">{r.reason}</div>{r.ticketNo && <div className="font-mono text-xs opacity-60">工单 {r.ticketNo}</div>}</div>) },
          { title: '提交时间', dataIndex: 'createdAt', render: fmtTime },
          { title: '操作', fixed: 'right', render: (_, r) => <Link to={`/approvals/${r.id}`}><Button size="small">详情</Button></Link> },
        ]}
      />
    </PageCard>
  )
}

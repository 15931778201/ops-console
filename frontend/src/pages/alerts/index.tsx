/**
 * 监控告警 · 告警事件列表（/alerts）；详情见 /alerts/events/:id。
 */

import { Button, Checkbox, Select, Space, Table, Tag } from 'antd'
import { Link } from 'react-router-dom'

import { ErrorAlert, Section, fmtTime } from '@/components/page'
import { usePagedList } from '@/hooks/usePagedList'
import { ALERT_STATUS_KIND, ALERT_STATUS_LABEL, SEVERITY_KIND, alertsApi, type AlertItem, type AlertSeverity, type AlertStatus } from '@/lib/alerts-api'

export const KIND_COLOR: Record<string, string> = { danger: 'error', warning: 'warning', default: 'default', primary: 'processing', success: 'success' }

interface Filters { severity?: AlertSeverity, status?: AlertStatus, onlyOpen?: boolean }

export default function AlertEventsPage() {
  const list = usePagedList<AlertItem, Filters>(
    q => alertsApi.list({ severity: q.severity, status: q.status, onlyOpen: q.onlyOpen, page: q.page, pageSize: q.pageSize }),
    {},
  )

  return (
    <Section title="告警事件">
      <div className="mb-3 text-sm opacity-70">按触发时间倒序；未恢复的条目即为当前仍在持续的故障。</div>
      <ErrorAlert error={list.error} />
      <Space className="!mb-3" wrap>
        <Select allowClear placeholder="全部级别" className="!w-36" value={list.filters.severity} onChange={v => list.setFilters({ ...list.filters, severity: v })} options={[{ value: 'P0', label: 'P0 立即处置' }, { value: 'P1', label: 'P1 当班处理' }, { value: 'P2', label: 'P2 观察跟进' }]} />
        <Select allowClear placeholder="全部投递状态" className="!w-40" value={list.filters.status} onChange={v => list.setFilters({ ...list.filters, status: v })} options={Object.entries(ALERT_STATUS_LABEL).map(([value, label]) => ({ value, label }))} />
        <Checkbox checked={!!list.filters.onlyOpen} onChange={e => list.setFilters({ ...list.filters, onlyOpen: e.target.checked })}>只看未恢复</Checkbox>
      </Space>
      <Table<AlertItem>
        rowKey="id"
        loading={list.loading}
        dataSource={list.items}
        pagination={list.pagination}
        scroll={{ x: 'max-content' }}
        rowClassName={a => (a.resolvedAt === null ? 'bg-red-50/60 dark:bg-red-900/10' : '')}
        locale={{ emptyText: '没有符合条件的告警事件' }}
        columns={[
          { title: '级别', dataIndex: 'severity', render: s => <Tag color={KIND_COLOR[SEVERITY_KIND[s as AlertSeverity]]}>{s}</Tag> },
          { title: '标题', render: (_, a) => (<div>{a.title}<div className="font-mono text-xs opacity-60">{a.ruleKey ?? 'manual'}</div></div>) },
          { title: '触发值 / 阈值', render: (_, a) => <span className="font-mono">{a.value ?? '—'} / {a.threshold ?? '—'}{a.hitStreak > 1 && <span className="text-xs opacity-60">{` （连续 ${a.hitStreak} 次）`}</span>}</span> },
          { title: '投递', dataIndex: 'status', render: s => <Tag color={KIND_COLOR[ALERT_STATUS_KIND[s as AlertStatus]]}>{ALERT_STATUS_LABEL[s as AlertStatus]}</Tag> },
          { title: '状态', dataIndex: 'resolvedAt', render: v => (v ? <Tag color="success">已恢复</Tag> : <Tag color="error">未恢复</Tag>) },
          { title: '时间', dataIndex: 'createdAt', render: fmtTime },
          { title: '操作', render: (_, a) => <Link to={`/alerts/events/${a.id}`}><Button size="small">详情</Button></Link> },
        ]}
      />
    </Section>
  )
}

/**
 * 审计日志列表（/audit）；单条详情（含元数据前后值）见 /audit/:id。权限：读 audit:read，导出 audit:export。
 * 动作分布点一下即作为筛选；导出是敏感操作（10 分钟 3 次），且导出行为本身也进审计。
 */

import { Alert, App, Button, DatePicker, Form, Input, Space, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { ErrorAlert, PageStack, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { auditApi, type AuditFilters, type AuditItem } from '@/lib/audit-api'
import { useAuthStore } from '@/stores/authStore'

export const ACTOR_TYPE_LABELS: Record<string, string> = { ADMIN: '管理员', USER: '用户', SYSTEM: '系统' }
const PAGE_SIZE = 20

export default function AuditPage() {
  const { message } = App.useApp()
  const canExport = useAuthStore(s => s.has('audit:export'))
  const [form] = Form.useForm()
  const [filters, setFilters] = useState<AuditFilters>({ page: 1, pageSize: PAGE_SIZE })
  const [exporting, setExporting] = useState(false)
  const [exportMax, setExportMax] = useState(10_000)

  const { data, loading, error, reload } = useRequest(() => auditApi.list(filters), [filters], '加载审计日志失败')

  useEffect(() => {
    auditApi.meta().then(m => setExportMax(m.exportMaxRows ?? 10_000)).catch(() => undefined)
  }, [])

  const apply = (v: Record<string, unknown>): void => {
    const range = (v.range ?? []) as Array<{ toISOString: () => string } | undefined>
    setFilters({
      page: 1,
      pageSize: PAGE_SIZE,
      actorId: (v.actorId as string) || undefined,
      actionPrefix: (v.actionPrefix as string) || undefined,
      targetId: (v.targetId as string) || undefined,
      requestId: (v.requestId as string) || undefined,
      reason: (v.reason as string) || undefined,
      since: range[0]?.toISOString(),
      until: range[1]?.toISOString(),
    })
  }

  const doExport = async (format: 'csv' | 'json'): Promise<void> => {
    setExporting(true)
    try {
      const { page: _p, pageSize: _s, ...f } = filters
      await auditApi.export(f, format)
      message.success(`已导出 ${format.toUpperCase()}，导出行为已记入审计日志`)
      await reload()
    }
    catch (e) {
      message.error(errText(e, '导出失败'))
    }
    finally {
      setExporting(false)
    }
  }

  return (
    <PageStack>
      <Section title="审计日志">
        <div className="text-sm opacity-70">所有后台写操作与敏感查询均在此留痕，可按操作者 / 动作 / 对象 / requestId 与后端日志串联。导出会记录导出人、时间、行数与筛选条件。</div>
      </Section>
      <ErrorAlert error={error} />
      {!canExport && <Alert type="info" showIcon message="你没有 audit:export 权限，仅可查询不可导出。" />}

      <Section title="动作分布">
        {(data?.byAction.length ?? 0) === 0
          ? <span className="text-sm opacity-60">暂无数据</span>
          : (
              <div className="flex flex-wrap gap-2">
                {data!.byAction.slice(0, 20).map(a => (
                  <Tag.CheckableTag key={a.action} checked={filters.actionPrefix === a.action} onChange={(on) => { form.setFieldValue('actionPrefix', on ? a.action : ''); setFilters(f => ({ ...f, page: 1, actionPrefix: on ? a.action : undefined })) }}>
                    {a.actionLabel} ×{a.count}
                  </Tag.CheckableTag>
                ))}
              </div>
            )}
      </Section>

      <Section title="筛选">
        <Form form={form} layout="inline" className="gap-y-2" onFinish={apply}>
          <Form.Item name="actorId" label="操作者 ID"><Input allowClear placeholder="管理员 ID" /></Form.Item>
          <Form.Item name="actionPrefix" label="动作前缀"><Input allowClear placeholder="plan. / approval. / flag." /></Form.Item>
          <Form.Item name="targetId" label="对象 ID"><Input allowClear placeholder="套餐 ID / 订单号 / 审批单 ID" /></Form.Item>
          <Form.Item name="requestId" label="requestId"><Input allowClear /></Form.Item>
          <Form.Item name="reason" label="原因包含"><Input allowClear placeholder="模糊匹配" /></Form.Item>
          <Form.Item name="range" label="时间"><DatePicker.RangePicker showTime /></Form.Item>
          <Space><Button type="primary" htmlType="submit">应用筛选</Button><Button onClick={() => { form.resetFields(); setFilters({ page: 1, pageSize: PAGE_SIZE }) }}>重置</Button></Space>
        </Form>
        {canExport && (
          <Space className="!mt-3">
            <span className="text-xs opacity-60">单次上限 {exportMax.toLocaleString()} 行 · 10 分钟 3 次</span>
            <Button size="small" loading={exporting} onClick={() => void doExport('csv')}>导出 CSV</Button>
            <Button size="small" loading={exporting} onClick={() => void doExport('json')}>导出 JSON</Button>
          </Space>
        )}
      </Section>

      <Section title={`明细（${data?.pagination.total ?? 0} 条）`}>
        <Table<AuditItem>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={data?.items ?? []}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '没有符合条件的审计记录' }}
          pagination={{ current: filters.page, pageSize: PAGE_SIZE, total: data?.pagination.total ?? 0, showSizeChanger: false, onChange: p => setFilters(f => ({ ...f, page: p })) }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', render: fmtTime },
            { title: '操作者', render: (_, it) => (<div><Tag color={it.actorType === 'ADMIN' ? 'processing' : 'default'}>{ACTOR_TYPE_LABELS[it.actorType] ?? it.actorType}</Tag><div className="text-xs opacity-60">{it.actorName ?? it.actorId ?? '—'}</div></div>) },
            { title: '动作', render: (_, it) => (<div>{it.actionLabel}<div className="font-mono text-xs opacity-60">{it.action}</div></div>) },
            { title: '对象', render: (_, it) => (it.targetType ? <div>{it.targetType}<div className="max-w-40 truncate font-mono text-xs opacity-60">{it.targetId ?? '—'}</div></div> : '—') },
            { title: '原因', dataIndex: 'reason', ellipsis: true, render: v => v ?? '—' },
            { title: 'requestId', dataIndex: 'requestId', render: v => <span className="font-mono text-xs">{v ?? '—'}</span> },
            { title: '操作', render: (_, it) => <Link to={`/audit/${it.id}`}><Button size="small">详情</Button></Link> },
          ]}
        />
      </Section>
    </PageStack>
  )
}

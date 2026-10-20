/**
 * 审计详情（/audit/:id）：单条审计记录的完整信息与元数据（前后值）。权限：audit:read。
 */

import { Button, Descriptions, Tag } from 'antd'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, PageStack, Section, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { auditApi } from '@/lib/audit-api'

import { ACTOR_TYPE_LABELS } from './index'

export default function AuditDetailPage() {
  const { id } = useParams()
  const { data: it, loading, error } = useRequest(() => auditApi.get(id!), [id], '加载审计详情失败')

  if (loading && !it) return <Loading />
  if (!it) return <div className="m-2"><ErrorAlert error={error ?? '记录不存在'} /></div>

  return (
    <PageStack>
      <Section title={`审计详情 · ${it.actionLabel}`} extra={<Link to="/audit"><Button>返回列表</Button></Link>}>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="时间">{fmtTime(it.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="操作者"><Tag color={it.actorType === 'ADMIN' ? 'processing' : 'default'}>{ACTOR_TYPE_LABELS[it.actorType] ?? it.actorType}</Tag> {it.actorName ?? '—'} <span className="font-mono opacity-60">{it.actorId ?? ''}</span></Descriptions.Item>
          <Descriptions.Item label="动作">{it.actionLabel} <span className="font-mono opacity-60">{it.action}</span></Descriptions.Item>
          <Descriptions.Item label="对象">{it.targetType ?? '—'} <span className="font-mono opacity-60">{it.targetId ?? ''}</span></Descriptions.Item>
          <Descriptions.Item label="原因">{it.reason ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="requestId"><span className="font-mono">{it.requestId ?? '—'}</span></Descriptions.Item>
        </Descriptions>
        <h4 className="mb-2 mt-4">元数据</h4>
        <pre className="max-h-96 overflow-auto rounded bg-black/5 p-3 text-xs dark:bg-white/10">{JSON.stringify(it.metadata ?? {}, null, 2)}</pre>
      </Section>
    </PageStack>
  )
}

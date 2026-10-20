/**
 * 监控告警 · 事件详情（/alerts/events/:id）
 */

import { Button, Descriptions, Tag } from 'antd'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, Section, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { ALERT_STATUS_KIND, ALERT_STATUS_LABEL, SEVERITY_KIND, SEVERITY_LABEL, alertsApi } from '@/lib/alerts-api'

import { KIND_COLOR } from '../index'

export default function AlertEventDetailPage() {
  const { id } = useParams()
  const { data: a, loading, error } = useRequest(() => alertsApi.get(id!), [id], '加载告警详情失败')

  if (loading && !a) return <Loading />
  if (!a) return <ErrorAlert error={error ?? '告警事件不存在'} />

  return (
    <Section title={`告警详情 · ${a.title}`} extra={<Link to="/alerts"><Button>返回列表</Button></Link>}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="级别"><Tag color={KIND_COLOR[SEVERITY_KIND[a.severity]]}>{a.severity}</Tag> <span className="opacity-60">{SEVERITY_LABEL[a.severity]}</span></Descriptions.Item>
        <Descriptions.Item label="规则"><span className="font-mono">{a.ruleKey ?? 'manual'}</span></Descriptions.Item>
        <Descriptions.Item label="指标"><span className="font-mono">{a.metric ?? '—'}</span></Descriptions.Item>
        <Descriptions.Item label="触发值 / 阈值"><span className="font-mono">{a.value ?? '—'} / {a.threshold ?? '—'}</span>（连续命中 {a.hitStreak} 次）</Descriptions.Item>
        <Descriptions.Item label="投递状态"><Tag color={KIND_COLOR[ALERT_STATUS_KIND[a.status]]}>{ALERT_STATUS_LABEL[a.status]}</Tag> 重试 {a.attempts} 次{a.lastError && <div className="text-xs opacity-60">外发失败：{a.lastError}</div>}</Descriptions.Item>
        <Descriptions.Item label="触发时间">{fmtTime(a.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="外发时间">{fmtTime(a.sentAt)}</Descriptions.Item>
        <Descriptions.Item label="恢复时间">{a.resolvedAt ? fmtTime(a.resolvedAt) : <Tag color="error">未恢复</Tag>}</Descriptions.Item>
      </Descriptions>
      <h4 className="mb-2 mt-4">详情数据</h4>
      <pre className="max-h-96 overflow-auto rounded bg-black/5 p-3 text-xs dark:bg-white/10">{JSON.stringify(a.detail ?? {}, null, 2)}</pre>
    </Section>
  )
}

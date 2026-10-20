/**
 * 监控告警 · 规则详情（/alerts/rules/:key）：状态 + 确认（已处置）/ 清除累积。
 */

import { Alert, App, Button, Descriptions, Space, Tag } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ConfirmModal, Section, errText, fmtTime } from '@/components/page'
import { SEVERITY_KIND, SEVERITY_LABEL, alertsApi, compareText, windowText } from '@/lib/alerts-api'

import { KIND_COLOR } from '../index'
import { useAlerts } from '../components/ctx'
import { RuleStateTag } from './index'

export default function AlertRuleDetailPage() {
  const { key } = useParams()
  const { message } = App.useApp()
  const { meta, canManage, refresh } = useAlerts()
  const [dialog, setDialog] = useState<'ack' | 'reset' | null>(null)
  const rule = meta.rules.find(r => r.key === key)

  if (!rule) return <Alert type="error" showIcon message="规则不存在" />

  return (
    <Section title={`规则详情 · ${rule.name}`} extra={<Link to="/alerts/rules"><Button>返回列表</Button></Link>}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="规则 key"><span className="font-mono">{rule.key}</span></Descriptions.Item>
        <Descriptions.Item label="级别"><Tag color={KIND_COLOR[SEVERITY_KIND[rule.severity]]}>{rule.severity}</Tag> <span className="opacity-60">{SEVERITY_LABEL[rule.severity]}</span></Descriptions.Item>
        <Descriptions.Item label="指标"><span className="font-mono">{rule.metric}</span></Descriptions.Item>
        <Descriptions.Item label="判定条件"><span className="font-mono">{compareText(rule)}</span></Descriptions.Item>
        <Descriptions.Item label="统计窗口">{windowText(rule.windowMs)}</Descriptions.Item>
        <Descriptions.Item label="当前状态"><RuleStateTag r={rule} threshold={meta.policy.consecutiveThreshold} /></Descriptions.Item>
        <Descriptions.Item label="最近触发">{rule.lastFiredAt ? fmtTime(rule.lastFiredAt) : '从未触发'}</Descriptions.Item>
        <Descriptions.Item label="最近恢复">{rule.lastResolvedAt ? fmtTime(rule.lastResolvedAt) : '—'}</Descriptions.Item>
      </Descriptions>
      {canManage && (
        <Space className="!mt-4">
          {rule.firing && <Button type="primary" onClick={() => setDialog('ack')}>确认（已处置）</Button>}
          {rule.hitStreak > 0 && !rule.firing && <Button onClick={() => setDialog('reset')}>清除累积</Button>}
        </Space>
      )}

      <ConfirmModal
        open={dialog !== null}
        title={dialog === 'ack' ? `确认告警「${rule.name}」` : `清除「${rule.name}」的累积`}
        okText={dialog === 'ack' ? '确认已处理' : '确认清除'}
        content={dialog === 'ack'
          ? <p>确认表示<b>值班已完成处置</b>。确认后该规则被置为非告警中，连续命中计数归零。确认只是"我知道了"，<b>不会修复问题</b>；若故障仍在，告警会再次触发。</p>
          : <p>将该规则的连续命中计数与告警状态清零，不会删除历史事件。</p>}
        reasonLabel="原因（必填，进入审计日志）"
        onCancel={() => setDialog(null)}
        onOk={async (reason) => {
          try {
            if (dialog === 'ack') {
              await alertsApi.acknowledge(rule.key, reason)
              message.success(`已确认「${rule.name}」，该规则不再重复累积命中`)
            }
            else {
              const r = await alertsApi.resetStates(rule.key, reason)
              message.success(`已重置 ${r.reset} 条规则状态`)
            }
            await refresh()
          }
          catch (e) {
            message.error(errText(e, '操作失败'))
          }
          setDialog(null)
        }}
      />
    </Section>
  )
}

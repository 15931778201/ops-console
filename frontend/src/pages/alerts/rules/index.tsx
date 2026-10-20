/**
 * 监控告警 · 规则清单（/alerts/rules）；详情见 /alerts/rules/:key。阈值由代码默认值与环境变量决定，不在本页修改。
 */

import { Button, Table, Tag } from 'antd'
import { Link } from 'react-router-dom'

import { Section } from '@/components/page'
import { SEVERITY_KIND, compareText, windowText, type AlertRule, type AlertSeverity } from '@/lib/alerts-api'

import { KIND_COLOR } from '../index'
import { useAlerts } from '../components/ctx'

export function RuleStateTag({ r, threshold }: { r: AlertRule, threshold: number }) {
  return r.firing ? <Tag color="error">告警中</Tag> : r.hitStreak > 0 ? <Tag color="warning">累积 {r.hitStreak}/{threshold}</Tag> : <Tag color="success">正常</Tag>
}

export default function AlertRulesPage() {
  const { meta } = useAlerts()
  return (
    <Section title="规则清单">
      <div className="mb-3 text-sm opacity-70">共 {meta.rules.length} 条规则；阈值由代码默认值与环境变量 ALERT_THRESHOLD_OVERRIDES 决定，不在本页修改。</div>
      <Table<AlertRule>
        rowKey="key"
        pagination={false}
        dataSource={meta.rules}
        scroll={{ x: 'max-content' }}
        rowClassName={r => (r.firing ? 'bg-red-50/60 dark:bg-red-900/10' : '')}
        columns={[
          { title: '规则', render: (_, r) => (<div>{r.name}<div className="font-mono text-xs opacity-60">{r.key}</div></div>) },
          { title: '级别', dataIndex: 'severity', render: s => <Tag color={KIND_COLOR[SEVERITY_KIND[s as AlertSeverity]]}>{s}</Tag> },
          { title: '判定条件', render: (_, r) => <span className="font-mono">{compareText(r)}</span> },
          { title: '统计窗口', dataIndex: 'windowMs', render: windowText },
          { title: '当前状态', render: (_, r) => <RuleStateTag r={r} threshold={meta.policy.consecutiveThreshold} /> },
          { title: '操作', render: (_, r) => <Link to={`/alerts/rules/${encodeURIComponent(r.key)}`}><Button size="small">详情</Button></Link> },
        ]}
      />
    </Section>
  )
}

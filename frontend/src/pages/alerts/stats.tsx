/**
 * 监控告警 · 统计复盘（/alerts/stats）：近 7 天；用于事后复盘与响应 SLA 评估。
 */

import { Alert, Card, Col, Empty, Row, Statistic, Table } from 'antd'
import { Link } from 'react-router-dom'

import { Loading, Section } from '@/components/page'

import { useAlerts } from './components/ctx'

export default function AlertStatsPage() {
  const { stats } = useAlerts()
  if (!stats) return <Loading />

  return (
    <Section title="统计复盘">
      {stats.total === 0
        ? <Empty description="近 7 天没有告警记录" />
        : (
            <>
              <Row gutter={12}>
                {[['总告警', stats.total], ['已恢复', stats.resolved], ['未恢复', stats.unresolved], ['外发失败', stats.sendFailed], ['仅落库', stats.suppressed]].map(([t, v]) => (
                  <Col key={t as string} xs={12} md={8} xl={4}><Card size="small"><Statistic title={t as string} value={v as number} /></Card></Col>
                ))}
              </Row>
              <Table
                className="!mt-4"
                rowKey="ruleKey"
                size="small"
                pagination={false}
                dataSource={stats.byRule}
                columns={[
                  { title: '规则', dataIndex: 'ruleKey', render: v => <Link className="font-mono" to={`/alerts/rules/${encodeURIComponent(v)}`}>{v}</Link> },
                  { title: '标题', dataIndex: 'title' },
                  { title: '次数', dataIndex: 'count' },
                ]}
              />
              {stats.sendFailed > 0 && <Alert className="!mt-3" type="warning" showIcon message={`近 7 天有 ${stats.sendFailed} 条告警外发失败。事件已落库不受影响，但值班群很可能没收到——请检查 webhook 可达性后重置对应规则状态。`} />}
            </>
          )}
    </Section>
  )
}

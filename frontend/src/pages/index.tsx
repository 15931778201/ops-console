/**
 * 仪表盘（/）：只读 dashboard_snapshots 快照，由定时任务每 5 分钟聚合写入。
 * 异常区每个数字可点击，跳到对应筛选页。
 */

import { Alert, Button, Card, Col, Row, Segmented, Statistic, Tag } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ErrorAlert, Loading, PageStack, errText, yuan } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { dashboardApi, type AnomalyKey, type Scope } from '@/lib/dashboard-api'

const SCOPE_OPTIONS: Array<{ label: string, value: Scope }> = [
  { label: '今日', value: 'today' },
  { label: '近 7 日', value: 'd7' },
  { label: '近 30 日', value: 'd30' },
]

type Kind = 'default' | 'success' | 'danger' | 'warning'
const COLORS: Record<Kind, string | undefined> = { default: undefined, success: '#52c41a', danger: '#ff4d4f', warning: '#faad14' }

function Metric({ label, value, hint, kind = 'default', onClick }: { label: string, value: string, hint?: string, kind?: Kind, onClick?: () => void }) {
  return (
    <Card size="small" hoverable={!!onClick} onClick={onClick} className={onClick ? 'cursor-pointer' : ''}>
      <Statistic title={label} value={value} valueStyle={{ color: COLORS[kind] }} />
      {hint && <div className="mt-1 text-xs opacity-60">{hint}</div>}
    </Card>
  )
}

function MetricRow({ children }: { children: React.ReactNode[] }) {
  return (
    <Row gutter={[12, 12]}>
      {children.map((c, i) => (
        <Col key={i} xs={12} md={8} xl={4}>{c}</Col>
      ))}
    </Row>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const [scope, setScope] = useState<Scope>('today')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const { data, setData, loading, error } = useRequest(() => dashboardApi.read(scope), [scope], '加载指标失败')

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setRefreshError('')
    try {
      setData(await dashboardApi.refresh(scope))
    }
    catch (e) {
      setRefreshError(errText(e, '刷新失败'))
    }
    finally {
      setRefreshing(false)
    }
  }

  const goAnomaly = (key: AnomalyKey): void => {
    const q = dashboardApi.anomalyLink(key)
    if (!q || !q.to) return
    const params = new URLSearchParams(q.query as Record<string, string>)
    navigate(params.size > 0 ? `${q.to}?${params.toString()}` : q.to)
  }

  const m = data?.metrics
  const a = m?.anomalies

  return (
    <PageStack>
      <div className="flex items-center justify-between">
        <Segmented options={SCOPE_OPTIONS} value={scope} onChange={v => setScope(v as Scope)} />
        <Button loading={refreshing} onClick={() => void refresh()}>立即刷新</Button>
      </div>
      <ErrorAlert error={error || refreshError} />

      {loading
        ? <Loading />
        : !data || !m || !a
            ? <Alert type="info" showIcon message="指标快照尚未生成。系统每 5 分钟自动聚合一次，也可点击右上角「立即刷新」。" />
            : (
                <>
                  {data.stale && (
                    <Alert
                      type="warning"
                      showIcon
                      message={`指标快照已过期（最后生成：${data.generatedAt ? new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}）。点击「立即刷新」获取最新数字。`}
                    />
                  )}

                  <Card title="异常与待处理" extra={<span className="text-xs opacity-60">点击数字跳转到对应处理页面</span>} variant="borderless">
                    <MetricRow>
                      {[
                        <Metric key="1" label="待支付超时订单" value={String(a.stalePendingOrders)} kind={a.stalePendingOrders > 0 ? 'warning' : 'default'} hint="创建超 30 分钟仍待支付" onClick={() => goAnomaly('stalePendingOrders')} />,
                        <Metric key="2" label="对账差异未处理" value={String(a.openReconciliations)} kind={a.openReconciliations > 0 ? 'warning' : 'default'} hint="渠道与本地状态不一致" onClick={() => goAnomaly('openReconciliations')} />,
                        <Metric key="3" label="账本不平账户" value={String(a.mismatchedAccounts)} kind={a.mismatchedAccounts > 0 ? 'danger' : 'default'} hint="投影与流水重算不一致" onClick={() => goAnomaly('mismatchedAccounts')} />,
                        <Metric key="4" label="负值余额账户" value={String(a.negativeAccounts)} kind={a.negativeAccounts > 0 ? 'danger' : 'default'} hint="负值防护被绕过，需立即排查" onClick={() => goAnomaly('negativeAccounts')} />,
                        <Metric key="5" label="回调验签失败" value={String(a.invalidSignatureEvents)} kind={a.invalidSignatureEvents > 0 ? 'warning' : 'default'} hint="支付回调签名校验不通过" onClick={() => goAnomaly('invalidSignatureEvents')} />,
                        <Metric key="6" label="重复回调" value={String(a.duplicateNotifyEvents)} kind={a.duplicateNotifyEvents > 0 ? 'warning' : 'default'} hint="已幂等拦截并留痕" onClick={() => goAnomaly('duplicateNotifyEvents')} />,
                      ]}
                    </MetricRow>
                  </Card>

                  <Card title="付费" variant="borderless">
                    <MetricRow>
                      {[
                        <Metric key="1" label="订单数" value={String(m.payment.orders)} hint="区间内创建" />,
                        <Metric key="2" label="支付成功" value={String(m.payment.paidOrders)} kind="success" />,
                        <Metric key="3" label="支付成功率" value={`${(m.payment.successRate * 100).toFixed(1)}%`} hint={`${m.payment.paidOrders} / ${m.payment.orders}`} kind={m.payment.successRate < 0.7 && m.payment.orders > 0 ? 'warning' : 'default'} />,
                        <Metric key="4" label="GMV" value={yuan(m.payment.gmvCents)} kind="success" hint="已支付订单金额合计" />,
                        <Metric key="5" label="客单价" value={yuan(m.payment.avgOrderCents)} hint="GMV / 成功订单数" />,
                        <Metric key="6" label="退款订单" value={String(m.payment.refundedOrders)} kind={m.payment.refundedOrders > 0 ? 'warning' : 'default'} />,
                      ]}
                    </MetricRow>
                  </Card>

                  <Row gutter={[8, 8]}>
                    <Col xs={24} lg={12}>
                      <Card title="用户" variant="borderless">
                        <MetricRow>
                          {[
                            <Metric key="1" label="新增注册" value={String(m.users.registrations)} hint="区间内注册" />,
                            <Metric key="2" label="活跃登录" value={String(m.users.activeLogins)} hint="区间内有登录" />,
                            <Metric key="3" label="禁用账号" value={String(m.users.suspended)} kind={m.users.suspended > 0 ? 'warning' : 'default'} hint="累计（非区间内）" onClick={() => navigate('/users?status=SUSPENDED')} />,
                          ]}
                        </MetricRow>
                      </Card>
                    </Col>
                    <Col xs={24} lg={12}>
                      <Card title="积分" variant="borderless">
                        <MetricRow>
                          {[
                            <Metric key="1" label="发放总量" value={m.credits.grantedTotal.toLocaleString()} hint="GRANT/RESET/BONUS/邀请" />,
                            <Metric key="2" label="消耗总量" value={m.credits.consumedTotal.toLocaleString()} hint="CONSUME 合计" />,
                            <Metric key="3" label="调账笔数" value={String(m.credits.adjustCount)} hint="经审批流执行" onClick={() => navigate('/approvals')} />,
                            <Metric key="4" label="调账净额" value={m.credits.adjustNet >= 0 ? `+${m.credits.adjustNet}` : String(m.credits.adjustNet)} kind={m.credits.adjustNet < 0 ? 'warning' : 'default'} hint="正为净发放，负为净扣减" />,
                          ]}
                        </MetricRow>
                      </Card>
                    </Col>
                  </Row>

                  <Card title="系统" variant="borderless">
                    <MetricRow>
                      {[
                        <Metric key="1" label="数据库" value={m.system.dbOk ? '正常' : '不可用'} kind={m.system.dbOk ? 'success' : 'danger'} />,
                        <Metric key="2" label="快照新鲜度" value={m.system.snapshotAgeMs === null ? '-' : `${Math.round(m.system.snapshotAgeMs / 1000)} 秒前`} kind={m.system.snapshotAgeMs !== null && m.system.snapshotAgeMs > 15 * 60 * 1000 ? 'warning' : 'default'} hint="超过 15 分钟视为过期" />,
                        <Metric key="3" label="聚合频率" value="5 分钟" hint="定时任务 dashboard_snapshot" />,
                      ]}
                    </MetricRow>
                    <div className="mt-3"><Tag>指标由定时任务聚合落库，页面只读快照（避免实时 COUNT 大表压库）</Tag></div>
                  </Card>
                </>
              )}
    </PageStack>
  )
}

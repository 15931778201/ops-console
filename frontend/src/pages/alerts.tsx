/**
 * 监控告警 · 共用布局：指标头部 + 立即检测（演练）+ 页面切换；子页面见 pages/alerts/*。
 *   /alerts 事件列表   /alerts/events/:id 事件详情   /alerts/rules 规则清单   /alerts/rules/:key 规则详情   /alerts/stats 统计复盘
 * 权限：读 alert:read，演练/确认/重置 alert:manage。页面没有改阈值的入口——阈值属配置，须走发布流程。
 */

import { Alert, App, Button, Card, Col, Row, Segmented, Space, Statistic } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Loading, PageStack, Section, errText } from '@/components/page'
import { alertsApi, type AlertMeta, type AlertStats, type EvaluateResult } from '@/lib/alerts-api'
import { useAuthStore } from '@/stores/authStore'

import type { AlertsCtx } from './alerts/components/ctx'

export default function AlertsLayout() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const canManage = useAuthStore(s => s.has('alert:manage'))
  const [meta, setMeta] = useState<AlertMeta | null>(null)
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [firingCount, setFiringCount] = useState(0)
  const [error, setError] = useState('')
  const [drillOpen, setDrillOpen] = useState(false)
  const [drillResult, setDrillResult] = useState<EvaluateResult | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [m, s, l] = await Promise.all([alertsApi.meta(), alertsApi.stats(7), alertsApi.list({ page: 1, pageSize: 1 })])
      setMeta(m)
      setStats(s)
      setFiringCount(l.firingCount)
    }
    catch (e) {
      setError(errText(e, '加载告警数据失败'))
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!meta) return error ? <div className="m-2"><ErrorAlert error={error} /></div> : <Loading text="加载告警…" />

  const ctx: AlertsCtx = { meta, stats, canManage, refresh }
  const tab = pathname.startsWith('/alerts/rules') ? '/alerts/rules' : pathname.startsWith('/alerts/stats') ? '/alerts/stats' : '/alerts'

  return (
    <PageStack>
      <Section
        title="监控告警"
        extra={(
          <Space>
            <Button size="small" onClick={() => void refresh()}>刷新</Button>
            {canManage && <Button size="small" type="primary" onClick={() => setDrillOpen(true)}>立即检测</Button>}
          </Space>
        )}
      >
        <div className="mb-3 text-xs opacity-60">评估周期 {Math.round(meta.policy.evalIntervalMs / 60000)} 分钟 · 连续命中 {meta.policy.consecutiveThreshold} 次才通知 · 静默窗口 {Math.round(meta.policy.silenceMs / 60000)} 分钟</div>
        <Row gutter={12}>
          {[['告警中', firingCount], ['近 7 天告警', stats?.total ?? 0], ['未恢复', stats?.unresolved ?? 0], ['外发失败', stats?.sendFailed ?? 0], ['平均恢复时长', stats?.avgResolveMinutes == null ? '—' : `${stats.avgResolveMinutes}m`]].map(([t, v]) => (
            <Col key={t as string} xs={12} md={8} xl={4}><Card size="small"><Statistic title={t as string} value={v as number | string} /></Card></Col>
          ))}
        </Row>
      </Section>

      <ErrorAlert error={error} />
      {!meta.channel.configured && <Alert type="warning" showIcon message="通知通道未配置" description="未设置 ALERT_WEBHOOK_URL，告警仍会完整落库并在本页可见，但不会推送到值班群。生产环境请配置该环境变量。" />}
      {!canManage && <Alert type="info" showIcon message="你有 alert:read 但没有 alert:manage，演练与确认为只读。值班处置需运营专员或超级管理员执行。" />}
      {drillResult && (
        <Alert
          type={drillResult.triggered.length > 0 ? 'warning' : 'info'}
          showIcon
          closable
          message="最近一次演练结果"
          description={<>评估 {drillResult.evaluated} 条规则；触发 {drillResult.triggered.join('、') || '无'}；恢复 {drillResult.recovered.join('、') || '无'}{drillResult.collectFailed.length > 0 && `；采集失败 ${drillResult.collectFailed.join('、')}（该规则本轮未判定）`}。<br />未触发不等于规则失效：连续命中阈值为 {meta.policy.consecutiveThreshold}，首次命中只累积不外发。</>}
        />
      )}

      <Segmented value={tab} onChange={v => navigate(v as string)} options={[{ value: '/alerts', label: '告警事件' }, { value: '/alerts/rules', label: '规则清单' }, { value: '/alerts/stats', label: '统计复盘' }]} className="self-start" />

      <Outlet context={ctx} />

      <ConfirmModal
        open={drillOpen}
        title="立即检测（告警演练）"
        okText="开始评估"
        content={<><p>将对全部 {meta.rules.length} 条规则执行一次实时评估，行为与定时任务完全一致。</p><ul className="m-0 pl-5"><li>连续命中不足 {meta.policy.consecutiveThreshold} 次的规则只累积不外发（正常现象）</li><li>评估会真实创建告警事件并尝试外发，不是模拟</li><li>演练原因会写入审计日志</li></ul></>}
        reasonLabel="演练原因（必填，进入审计日志）"
        reasonPlaceholder="例如：季度告警演练，验证通道与值班响应"
        onCancel={() => setDrillOpen(false)}
        onOk={async (reason) => {
          try {
            const res = await alertsApi.evaluate(reason)
            setDrillResult(res)
            message.success(`评估完成：${res.evaluated} 条规则，触发 ${res.triggered.length}，恢复 ${res.recovered.length}，采集失败 ${res.collectFailed.length}`)
            await refresh()
          }
          catch (e) {
            message.error(errText(e, '触发评估失败'))
          }
          setDrillOpen(false)
        }}
      />
    </PageStack>
  )
}

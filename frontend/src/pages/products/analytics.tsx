/**
 * 产品数据分析（/products/analytics?pid=）：总览 / 转化率 / 定价策略 / 平台流量。
 */

import { Alert, Card, Col, Row, Segmented, Select, Statistic, Table } from 'antd'
import { useState } from 'react'

import { EChart } from '@/components/chart/EChart'
import { ErrorAlert, Loading, Section, yuan } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product, type ProductAnalytics } from '@/lib/product-api'

import { ProductScope } from './components/scope'

const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#dc2626']
const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-')

function Overview({ d }: { d: ProductAnalytics }) {
  const option = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['访问', '下载', '收入（元）'] },
    grid: { left: 48, right: 48, top: 40, bottom: 24 },
    xAxis: { type: 'category', data: d.series.map(s => s.date.slice(5)) },
    yAxis: [{ type: 'value' }, { type: 'value' }],
    series: [
      { name: '访问', type: 'line', smooth: true, data: d.series.map(s => s.visits), color: PALETTE[0] },
      { name: '下载', type: 'line', smooth: true, data: d.series.map(s => s.downloads), color: PALETTE[1] },
      { name: '收入（元）', type: 'bar', yAxisIndex: 1, data: d.series.map(s => s.revenueCents / 100), color: PALETTE[2], barMaxWidth: 16 },
    ],
  }
  const stats: Array<[string, string]> = [
    ['访问量', d.totals.visits.toLocaleString()], ['下载量', d.totals.downloads.toLocaleString()], ['峰值活跃用户', d.totals.activeUsers.toLocaleString()],
    ['付费用户', d.totals.paidUsers.toLocaleString()], ['收入', yuan(d.totals.revenueCents)], ['访问→付费', pct(d.totals.paidUsers, d.totals.visits)], ['平均评分', d.totals.avgRating.toFixed(1)],
  ]
  return (
    <>
      <Row gutter={[12, 12]}>{stats.map(([t, v]) => <Col key={t} xs={12} md={6} xl={3}><Card size="small"><Statistic title={t} value={v} /></Card></Col>)}</Row>
      <Section title="流量与收入趋势"><EChart option={option} height={320} label="访问、下载与收入趋势图" /></Section>
    </>
  )
}

function Funnel({ d }: { d: ProductAnalytics }) {
  const funnel = {
    tooltip: { trigger: 'item', formatter: '{b}：{c}' },
    series: [{ type: 'funnel', left: '8%', width: '84%', top: 10, bottom: 10, sort: 'none', gap: 2, label: { position: 'inside', formatter: '{b} {c}' }, data: d.funnel.map((f, i) => ({ name: f.stage, value: f.count, itemStyle: { color: PALETTE[i % PALETTE.length] } })) }],
  }
  const steps = d.funnel.slice(1).map((f, i) => ({ name: `${d.funnel[i]!.stage}→${f.stage}`, rate: d.funnel[i]!.count > 0 ? (f.count / d.funnel[i]!.count) * 100 : 0 }))
  const rate = {
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v.toFixed(1)}%` },
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: steps.map(s => s.name) },
    yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
    series: [{ type: 'bar', data: steps.map(s => Number(s.rate.toFixed(1))), color: PALETTE[0], barMaxWidth: 40, label: { show: true, position: 'top', formatter: '{c}%' } }],
  }
  const worst = steps.reduce((a, b) => (b.rate < a.rate ? b : a), steps[0]!)
  return (
    <>
      <Alert type="info" showIcon message={`整体转化 ${pct(d.funnel[d.funnel.length - 1]!.count, d.funnel[0]!.count)}；流失最大的环节是「${worst.name}」（${worst.rate.toFixed(1)}%），建议优先优化。`} />
      <Section title="转化漏斗"><EChart option={funnel} height={320} label="转化漏斗图" /></Section>
      <Section title="相邻环节转化率"><EChart option={rate} height={260} label="相邻环节转化率柱状图" /></Section>
    </>
  )
}

function Pricing({ d }: { d: ProductAnalytics }) {
  const share = { tooltip: { trigger: 'item', formatter: '{b}：¥{c}（{d}%）' }, legend: { bottom: 0 }, series: [{ type: 'pie', radius: ['45%', '70%'], data: d.pricing.map((p, i) => ({ name: p.planName, value: p.revenueCents / 100, itemStyle: { color: PALETTE[i % PALETTE.length] } })) }] }
  type P = { data: [number, number, number, string] }
  const scatter = {
    tooltip: { formatter: (x: P) => `${x.data[3]}<br/>价格 ¥${x.data[0]}<br/>转化率 ${x.data[1]}%<br/>订单 ${x.data[2]}` },
    grid: { left: 52, right: 24, top: 24, bottom: 40 },
    xAxis: { type: 'value', name: '价格（元）', nameLocation: 'middle', nameGap: 26 },
    yAxis: { type: 'value', name: '转化率', axisLabel: { formatter: '{value}%' } },
    series: [{ type: 'scatter', symbolSize: (v: number[]) => 14 + Math.sqrt(v[2]!) * 2, data: d.pricing.map(p => [p.priceCents / 100, Number((p.conversionRate * 100).toFixed(2)), p.orders, p.planName]), color: PALETTE[0], label: { show: true, position: 'top', formatter: (x: P) => x.data[3] } }],
  }
  const refund = {
    tooltip: { trigger: 'axis' }, legend: { data: ['订单数', '退款率'] }, grid: { left: 48, right: 48, top: 40, bottom: 28 },
    xAxis: { type: 'category', data: d.pricing.map(p => p.planName) },
    yAxis: [{ type: 'value' }, { type: 'value', axisLabel: { formatter: '{value}%' } }],
    series: [
      { name: '订单数', type: 'bar', data: d.pricing.map(p => p.orders), color: PALETTE[0], barMaxWidth: 36 },
      { name: '退款率', type: 'line', yAxisIndex: 1, data: d.pricing.map(p => Number((p.refundRate * 100).toFixed(1))), color: PALETTE[4] },
    ],
  }
  const best = d.pricing.reduce((a, b) => (b.revenueCents > a.revenueCents ? b : a), d.pricing[0]!)
  return (
    <>
      <Alert type="info" showIcon message={`收入贡献最高：${best.planName}（${yuan(best.revenueCents)}，占 ${pct(best.revenueCents, d.pricing.reduce((a, p) => a + p.revenueCents, 0))}）。调价前请结合价格-转化率与退款率判断弹性，调价入口见「产品套餐」。`} />
      <Row gutter={[8, 8]}>
        <Col xs={24} lg={12}><Section title="套餐收入占比"><EChart option={share} label="套餐收入占比饼图" /></Section></Col>
        <Col xs={24} lg={12}><Section title="价格 × 转化率" extra={<span className="text-xs opacity-60">气泡越大订单越多</span>}><EChart option={scatter} label="价格与转化率散点图" /></Section></Col>
      </Row>
      <Section title="订单量与退款率"><EChart option={refund} height={260} label="订单量与退款率图" /></Section>
      <Section title="套餐明细">
        <Table
          rowKey="planName"
          size="small"
          pagination={false}
          dataSource={d.pricing}
          columns={[
            { title: '套餐', dataIndex: 'planName' },
            { title: '价格', dataIndex: 'priceCents', render: yuan },
            { title: '折合月价', render: (_, p) => yuan(Math.round(p.priceCents / p.periodMonths)) },
            { title: '订单', dataIndex: 'orders' },
            { title: '收入', dataIndex: 'revenueCents', render: yuan },
            { title: '转化率', dataIndex: 'conversionRate', render: v => `${(v * 100).toFixed(1)}%` },
            { title: '退款率', dataIndex: 'refundRate', render: v => `${(v * 100).toFixed(1)}%` },
          ]}
        />
      </Section>
    </>
  )
}

function Traffic({ d }: { d: ProductAnalytics }) {
  const keys = ['windows', 'macos', 'linux', 'web'] as const
  const trend = {
    tooltip: { trigger: 'axis' }, legend: { data: [...keys] }, grid: { left: 48, right: 16, top: 40, bottom: 24 },
    xAxis: { type: 'category', boundaryGap: false, data: d.platformSeries.map(s => s.date.slice(5)) }, yAxis: { type: 'value' },
    series: keys.map((k, i) => ({ name: k, type: 'line', stack: 'visits', areaStyle: {}, smooth: true, data: d.platformSeries.map(s => s[k]), color: PALETTE[i] })),
  }
  const compare = {
    tooltip: { trigger: 'axis' }, legend: { data: ['访问', '下载', '付费'] }, grid: { left: 48, right: 16, top: 40, bottom: 24 },
    xAxis: { type: 'category', data: d.platforms.map(p => p.platform) }, yAxis: { type: 'value' },
    series: [
      { name: '访问', type: 'bar', data: d.platforms.map(p => p.visits), color: PALETTE[0] },
      { name: '下载', type: 'bar', data: d.platforms.map(p => p.downloads), color: PALETTE[1] },
      { name: '付费', type: 'bar', data: d.platforms.map(p => p.paid), color: PALETTE[2] },
    ],
  }
  const channels = { tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' }, legend: { bottom: 0 }, series: [{ type: 'pie', radius: '65%', data: d.channels.map((c, i) => ({ name: c.channel, value: c.visits, itemStyle: { color: PALETTE[i % PALETTE.length] } })) }] }
  return (
    <>
      <Section title="各平台访问趋势" extra={<span className="text-xs opacity-60">堆叠面积图，总高度为总访问量</span>}><EChart option={trend} height={320} label="各平台访问趋势图" /></Section>
      <Row gutter={[8, 8]}>
        <Col xs={24} lg={12}><Section title="平台漏斗对比"><EChart option={compare} label="平台访问下载付费对比图" /></Section></Col>
        <Col xs={24} lg={12}><Section title="流量来源"><EChart option={channels} label="流量来源饼图" /></Section></Col>
      </Row>
      <Section title="平台转化明细">
        <Table
          rowKey="platform"
          size="small"
          pagination={false}
          dataSource={d.platforms}
          columns={[
            { title: '平台', dataIndex: 'platform' },
            { title: '访问', dataIndex: 'visits', render: (v: number) => v.toLocaleString() },
            { title: '下载', dataIndex: 'downloads', render: (v: number) => v.toLocaleString() },
            { title: '付费', dataIndex: 'paid', render: (v: number) => v.toLocaleString() },
            { title: '访问→下载', render: (_, p) => pct(p.downloads, p.visits) },
            { title: '下载→付费', render: (_, p) => pct(p.paid, p.downloads) },
          ]}
        />
      </Section>
    </>
  )
}

function AnalyticsView({ product }: { product: Product }) {
  const [days, setDays] = useState(14)
  const [tab, setTab] = useState<'overview' | 'funnel' | 'pricing' | 'traffic'>('overview')
  const { data, loading, error } = useRequest(() => productApi.analytics(product.id, days), [product.id, days], '加载数据失败')

  return (
    <>
      <div className="flex items-center justify-between rounded bg-white p-3 dark:bg-[#141414]">
        <Segmented value={tab} onChange={v => setTab(v as typeof tab)} options={[{ value: 'overview', label: '总览' }, { value: 'funnel', label: '转化率' }, { value: 'pricing', label: '定价策略' }, { value: 'traffic', label: '平台流量' }]} />
        <Select value={days} onChange={setDays} className="!w-28" options={[{ value: 7, label: '近 7 天' }, { value: 14, label: '近 14 天' }, { value: 30, label: '近 30 天' }]} />
      </div>
      <ErrorAlert error={error} />
      {loading && !data ? <Loading /> : data && (tab === 'overview' ? <Overview d={data} /> : tab === 'funnel' ? <Funnel d={data} /> : tab === 'pricing' ? <Pricing d={data} /> : <Traffic d={data} />)}
    </>
  )
}

export default function ProductAnalyticsPage() {
  return <ProductScope>{p => <AnalyticsView product={p} />}</ProductScope>
}

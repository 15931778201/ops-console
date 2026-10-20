/**
 * 系统开关（/flags）。权限：读 flag:read，改 flag:write（仅 SUPER_ADMIN）。
 * 操作的是资金链路的总闸：每个开关列出影响范围；高危开关要求输入确认词；切换必须填原因（进审计）；
 * 值未变化时后端不写审计，前端据 changed 如实提示。
 */

import { Alert, App, Button, Card, Empty, Space, Tag } from 'antd'
import { useState } from 'react'

import { ConfirmModal, ErrorAlert, Loading, PageStack, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { flagsApi, type FlagItem } from '@/lib/flags-api'
import { useAuthStore } from '@/stores/authStore'

/** 高危开关：切换前需要输入确认词 */
const CRITICAL: Record<string, { verifyText: string, impact: string[], safe: string[] }> = {
  paymentAcceptingOrders: {
    verifyText: '停收',
    impact: ['新订单创建被拒（HTTP 503，前端提示"暂时无法购买"）', '用户端购买 CTA 立即隐藏（前端读 /api/payment/flags）', '已创建的待支付订单不受影响，仍可完成支付'],
    safe: ['已付款用户的订单查询', '订单详情与对账', '退款申请与审批', '所有查询类后台接口'],
  },
  registrationOpen: {
    verifyText: '停注册',
    impact: ['新用户无法注册（HTTP 503）', '注册页展示"暂停注册"提示'],
    safe: ['已存在用户的登录与使用', '密码找回', '账号注销'],
  },
  paymentMockChannel: {
    verifyText: 'Mock',
    impact: ['启用 Mock 支付通道（仅开发/预生产可用）'],
    safe: ['真实渠道订单不受影响'],
  },
}

function Impact({ c }: { c: (typeof CRITICAL)[string] }) {
  return (
    <>
      <b>影响：</b>
      <ul className="m-0 mb-2 pl-5">{c.impact.map(x => <li key={x}>{x}</li>)}</ul>
      <b>不受影响：</b>
      <ul className="m-0 pl-5">{c.safe.map(x => <li key={x}>{x}</li>)}</ul>
    </>
  )
}

export default function FlagsPage() {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('flag:write'))
  const [pending, setPending] = useState<{ flag: FlagItem, next: boolean } | null>(null)
  const [resetting, setResetting] = useState<FlagItem | null>(null)
  const { data: items, loading, error, reload } = useRequest(() => flagsApi.list(), [], '加载开关列表失败')

  if (loading && !items) return <Loading text="加载开关…" />

  const critical = pending ? CRITICAL[pending.flag.key] : undefined

  return (
    <PageStack>
      <Section title="系统开关">
        <div className="text-sm opacity-70">变更立即全进程生效（毫秒级，无需等待），每次变更都会写入审计日志。高危操作需输入确认词，且原因会进入审计日志。</div>
      </Section>
      <ErrorAlert error={error} />
      {!canWrite && <Alert type="info" showIcon message="你有 flag:read 但没有 flag:write，开关为只读。停收等高危操作需超级管理员执行。" />}

      {!items || items.length === 0
        ? <Empty description="暂无开关" />
        : items.map((f) => {
            const c = CRITICAL[f.key]
            return (
              <Card key={f.key} variant="borderless">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Space><b>{f.label}</b><Tag color={f.value ? 'success' : 'error'}>{f.value ? '开启' : '关闭'}</Tag>{!f.hasOverride && <Tag>使用默认值</Tag>}</Space>
                    <div className="text-sm opacity-70">{f.description}</div>
                    <div className="font-mono text-xs opacity-60">{f.flag}</div>
                  </div>
                  <Space>
                    {f.updatedAt && <span className="text-xs opacity-60">最后变更：{fmtTime(f.updatedAt)}</span>}
                    {canWrite && (
                      <>
                        <Button size="small" danger={!f.value} onClick={() => setPending({ flag: f, next: !f.value })}>{f.value ? '关闭' : '开启'}</Button>
                        {f.hasOverride && <Button size="small" onClick={() => setResetting(f)}>恢复默认</Button>}
                      </>
                    )}
                  </Space>
                </div>
                {c && !f.value && <Alert className="!mt-3" type="warning" showIcon message="当前已关闭" description={<Impact c={c} />} />}
              </Card>
            )
          })}

      <ConfirmModal
        open={!!pending}
        danger={!!critical && pending?.next === false}
        title={pending ? `${pending.next ? '开启' : '关闭'}「${pending.flag.label}」` : ''}
        okText={pending?.next ? '确认开启' : '确认关闭'}
        verifyText={critical?.verifyText}
        content={<><p>{pending?.flag.description}</p>{critical && pending?.next === false && <Impact c={critical} />}</>}
        reasonLabel="操作原因（必填，进入审计日志）"
        reasonPlaceholder={pending?.next ? '例如：渠道故障已修复，恢复售卖' : '例如：支付渠道维护，暂时停止收单'}
        onCancel={() => setPending(null)}
        onOk={async (reason) => {
          const p = pending!
          try {
            const res = await flagsApi.set(p.flag.key, p.next, reason)
            message.success(res.changed ? `${p.flag.label} 已${p.next ? '开启' : '关闭'}，立即生效` : `${p.flag.label} 本来就是${p.next ? '开启' : '关闭'}状态，未产生变更记录`)
            await reload()
          }
          catch (e) {
            message.error(errText(e, '操作失败'))
          }
          setPending(null)
        }}
      />
      <ConfirmModal
        open={!!resetting}
        title={`恢复默认 · ${resetting?.label}`}
        okText="恢复默认"
        content={<p>将「{resetting?.label}」恢复为代码默认值。</p>}
        reasonLabel="操作原因（必填）"
        onCancel={() => setResetting(null)}
        onOk={async (reason) => {
          const f = resetting!
          try {
            await flagsApi.reset(f.key, reason)
            message.success(`「${f.label}」已恢复默认值`)
            await reload()
          }
          catch (e) {
            message.error(errText(e, '恢复默认失败'))
          }
          setResetting(null)
        }}
      />
    </PageStack>
  )
}

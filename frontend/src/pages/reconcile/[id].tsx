/**
 * 对账差异详情（/reconcile/:id）
 * 权限：reconcile:read 查看；reconcile:handle 人工标记 / 重试补结算（幂等）。
 * 人机边界：AUTO_SETTLED 由系统写入，前端不提供"手工标记已结算"入口。
 */

import { App, Button, Descriptions, Form, Input, Select, Space, Tag } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Loading, PageStack, ReconActionTag, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { api } from '@/lib/api-client'
import { useAuthStore } from '@/stores/authStore'

import { DIFF_COLORS, DIFF_LABELS, HANDLE_ACTIONS, type ReconRecord } from './index'

export default function ReconcileDetailPage() {
  const { id } = useParams()
  const { message } = App.useApp()
  const has = useAuthStore(s => s.has)
  const [form] = Form.useForm<{ action: string, note: string }>()
  const [resettling, setResettling] = useState(false)
  const [busy, setBusy] = useState(false)
  const { data: rec, loading, error, reload } = useRequest(() => api.get<ReconRecord>(`/reconciliations/${id}`), [id], '加载失败')

  if (loading && !rec) return <Loading />
  if (!rec) return <div className="m-2"><ErrorAlert error={error ?? '记录不存在'} /></div>

  const canHandle = has('reconcile:handle') && rec.action === null

  const submit = async (v: { action: string, note: string }): Promise<void> => {
    setBusy(true)
    try {
      await api.post(`/reconciliations/${rec.id}/handle`, { action: v.action, note: v.note.trim() })
      message.success(`已标记为「${HANDLE_ACTIONS.find(a => a.value === v.action)?.label}」`)
      form.resetFields()
      await reload()
    }
    catch (e) {
      message.error(errText(e, '处理失败'))
    }
    finally {
      setBusy(false)
    }
  }

  const resettle = async (): Promise<void> => {
    try {
      const r = await api.post<{ orderNo: string, settled: boolean, note: string }>(`/reconciliations/${rec.id}/resettle`)
      message.success(r.settled ? `已补结算 ${r.orderNo}` : r.note)
      await reload()
    }
    catch (e) {
      message.error(errText(e, '补结算失败'))
    }
    setResettling(false)
  }

  return (
    <PageStack>
      <Section title="对账差异详情" extra={<Link to="/reconcile"><Button>返回列表</Button></Link>}>
        <div className="mb-3 text-sm opacity-70">此处只标记工单状态，不直接改动资金；金额不一致必须交财务人工核实。</div>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="订单号"><Link to={`/orders/${rec.orderNo}`} className="font-mono">{rec.orderNo}</Link></Descriptions.Item>
          <Descriptions.Item label="差异类型"><Tag color={DIFF_COLORS[rec.diffType]}>{DIFF_LABELS[rec.diffType] ?? rec.diffType}</Tag></Descriptions.Item>
          <Descriptions.Item label="支付渠道">{rec.channel}</Descriptions.Item>
          <Descriptions.Item label="本地 / 渠道状态"><span className="font-mono">{rec.localStatus} / {rec.channelStatus}</span></Descriptions.Item>
          <Descriptions.Item label="处理状态"><ReconActionTag action={rec.action} /></Descriptions.Item>
          <Descriptions.Item label="发现时间">{fmtTime(rec.createdAt)}</Descriptions.Item>
          <Descriptions.Item label="处理人 / 时间">{rec.handledBy ?? '—'} {rec.handledAt ? `· ${fmtTime(rec.handledAt)}` : ''}</Descriptions.Item>
          <Descriptions.Item label="备注">{rec.note ?? '—'}</Descriptions.Item>
        </Descriptions>
      </Section>

      {canHandle && (
        <Section title="处理" extra={rec.diffType === 'PAID_LOCAL_PENDING' && <Button type="primary" onClick={() => setResettling(true)}>重试补结算</Button>}>
          <Form form={form} layout="vertical" initialValues={{ action: 'MANUAL_DONE' }} onFinish={v => void submit(v)} className="max-w-xl">
            <Form.Item name="action" label="处理结果"><Select options={[...HANDLE_ACTIONS]} /></Form.Item>
            <Form.Item name="note" label="处理说明（必填，写入审计日志）" rules={[{ required: true, min: 2, message: '请填写至少 2 个字符的处理说明' }]}>
              <Input.TextArea rows={3} placeholder="例如：已联系用户确认收款；或金额差异已提交财务核对" />
            </Form.Item>
            <Space><Button type="primary" htmlType="submit" loading={busy}>提交处理结果</Button></Space>
          </Form>
        </Section>
      )}

      <ConfirmModal
        open={resettling}
        title="重试补结算"
        okText="确认补结算"
        content={<p>将再次向渠道查单。若渠道已付而本地仍为待支付，会执行补结算并发放权益。<br /><b>补结算是幂等的</b>：若权益已发放过，不会重复发放。</p>}
        onCancel={() => setResettling(false)}
        onOk={resettle}
      />
    </PageStack>
  )
}

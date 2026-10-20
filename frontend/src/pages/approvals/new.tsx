/**
 * 提交调账申请（/approvals/new）。权限：credit:adjust:apply。提交后进入审批流。
 */

import { Button, Form, Input, InputNumber, Space } from 'antd'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { ErrorAlert, PageCard, errText } from '@/components/page'
import { approvalApi } from '@/lib/approval-api'

interface Values { userId: string, ticketNo?: string, deltaBalance: number, deltaBonus: number, reason: string }

export default function ApprovalCreatePage() {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (v: Values): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const created = await approvalApi.submit({
        type: 'CREDIT_ADJUST',
        payload: { userId: v.userId.trim(), deltaBalance: Number(v.deltaBalance), deltaBonus: Number(v.deltaBonus), reason: v.reason.trim() },
        reason: v.reason.trim(),
        ticketNo: v.ticketNo?.trim() || undefined,
      })
      navigate(`/approvals/${created.id}`, { replace: true })
    }
    catch (e) {
      setError(errText(e, '提交失败'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <PageCard title="提交调账申请" extra={<Link to="/approvals"><Button>返回列表</Button></Link>}>
      <div className="mb-3 text-sm opacity-70">提交后等待财务审批；申请人不能审批自己的单子。</div>
      <ErrorAlert error={error} />
      <Form layout="vertical" className="max-w-2xl" initialValues={{ deltaBalance: 0, deltaBonus: 0 }} onFinish={v => void submit(v)}>
        <Form.Item name="userId" label="目标用户 ID" rules={[{ required: true }]}><Input placeholder="用户 ID" /></Form.Item>
        <Form.Item name="ticketNo" label="工单号（可选）"><Input placeholder="如 TK-2026-0001" /></Form.Item>
        <Form.Item name="deltaBalance" label="订阅积分调整" extra="正数为增加，负数为扣减；单笔绝对值上限 100,000" rules={[{ required: true }]}><InputNumber className="!w-full" /></Form.Item>
        <Form.Item name="deltaBonus" label="奖励积分调整" extra="可累积的奖励积分"><InputNumber className="!w-full" /></Form.Item>
        <Form.Item name="reason" label="调账原因（必填，写入审计与流水）" rules={[{ required: true, min: 2 }]}><Input.TextArea rows={3} placeholder="例如：用户重复支付补偿，工单 TK-2026-0001 核实通过" /></Form.Item>
        <Space><Button type="primary" htmlType="submit" loading={busy}>提交申请</Button></Space>
      </Form>
    </PageCard>
  )
}

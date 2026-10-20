/**
 * 审批单详情（/approvals/:id）
 * 权限：approval:read 查看；credit:adjust:execute 批准/拒绝/重试；申请人可撤回自己的待审单。
 * 批准前展示影响预览；申请人不能审批/执行自己的单子（后端 409 兜底）；批准即执行；"重试执行"只对 FAILED 显示且幂等。
 */

import { Alert, App, Button, Card, Col, Descriptions, Row, Space, Statistic } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ConfirmModal, ErrorAlert, Loading, PageStack, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { APPROVAL_STATUS_LABELS, APPROVAL_TYPE_LABELS, approvalApi, type CreditAdjustPayload, type CreditAdjustPreview } from '@/lib/approval-api'
import { useAuthStore } from '@/stores/authStore'

import { ApprovalStatusTag, formatPayload } from './components/shared'

type Dialog = 'approve' | 'reject' | 'execute' | null

export default function ApprovalDetailPage() {
  const { id } = useParams()
  const { message } = App.useApp()
  const admin = useAuthStore(s => s.admin)
  const has = useAuthStore(s => s.has)
  const [dialog, setDialog] = useState<Dialog>(null)

  const { data, loading, error, reload } = useRequest(async () => {
    const d = await approvalApi.get(id!)
    let preview: CreditAdjustPreview | null = null
    if (d.type === 'CREDIT_ADJUST') {
      const p = d.payload as CreditAdjustPayload
      preview = await approvalApi.preview({ userId: p.userId, deltaBalance: p.deltaBalance, deltaBonus: p.deltaBonus, reason: p.reason ?? d.reason })
    }
    return { d, preview }
  }, [id], '加载详情失败')

  if (loading && !data) return <Loading />
  if (!data) return <div className="m-2"><ErrorAlert error={error ?? '审批单不存在'} /></div>

  const { d: detail, preview } = data
  const isMine = detail.applicantId === admin?.id
  const canDecide = has('credit:adjust:execute')

  const run = async (fn: () => Promise<string>, fail: string): Promise<void> => {
    try {
      message.success(await fn())
      await reload()
    }
    catch (e) {
      message.error(errText(e, fail))
    }
    setDialog(null)
  }

  return (
    <PageStack>
      <Section
        title={`审批单详情 · ${APPROVAL_TYPE_LABELS[detail.type]}`}
        extra={(
          <Space>
            <Link to="/approvals"><Button>返回列表</Button></Link>
            {canDecide && !isMine && detail.status === 'PENDING' && (<><Button type="primary" onClick={() => setDialog('approve')}>批准</Button><Button danger onClick={() => setDialog('reject')}>拒绝</Button></>)}
            {canDecide && detail.status === 'FAILED' && detail.approverId && <Button type="primary" onClick={() => setDialog('execute')}>重试执行</Button>}
            {has('credit:adjust:apply') && isMine && detail.status === 'PENDING' && <Button onClick={() => void run(async () => { await approvalApi.cancel(detail.id); return '已撤回' }, '撤回失败')}>撤回申请</Button>}
          </Space>
        )}
      >
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="状态"><ApprovalStatusTag status={detail.status} label={APPROVAL_STATUS_LABELS[detail.status]} /></Descriptions.Item>
          <Descriptions.Item label="内容">{formatPayload(detail.payload)}</Descriptions.Item>
          <Descriptions.Item label="申请人"><span className="font-mono">{detail.applicantId}</span>{isMine && '（我）'}</Descriptions.Item>
          <Descriptions.Item label="审批人"><span className="font-mono">{detail.approverId ?? '—'}</span></Descriptions.Item>
          <Descriptions.Item label="工单号"><span className="font-mono">{detail.ticketNo ?? '—'}</span></Descriptions.Item>
          <Descriptions.Item label="原因">{detail.reason}</Descriptions.Item>
          <Descriptions.Item label="提交时间">{fmtTime(detail.createdAt)}</Descriptions.Item>
          {detail.approvedAt && <Descriptions.Item label="批准时间">{fmtTime(detail.approvedAt)}</Descriptions.Item>}
          {detail.executedAt && <Descriptions.Item label="执行时间">{fmtTime(detail.executedAt)}</Descriptions.Item>}
          {detail.result && <Descriptions.Item label="执行结果" span={2}><span className="font-mono">{JSON.stringify(detail.result)}</span></Descriptions.Item>}
        </Descriptions>
      </Section>

      {preview && (
        <Section title="影响预览">
          <Row gutter={12}>
            <Col xs={24} md={12}><Card size="small"><Statistic title="订阅积分" value={`${preview.currentBalance} → ${preview.afterBalance}`} /></Card></Col>
            <Col xs={24} md={12}><Card size="small"><Statistic title="奖励积分" value={`${preview.currentBonus} → ${preview.afterBonus}`} /></Card></Col>
          </Row>
          <Space direction="vertical" className="mt-3 w-full">
            {preview.wouldGoNegative && <Alert type="error" showIcon message="调整后余额为负，后端将拒绝执行。" />}
            {preview.requiresSuperAdmin && <Alert type="warning" showIcon message={`单笔调整超过 ${preview.maxAbs}，需 SUPER_ADMIN 审批。`} />}
            {preview.recentCount >= 3 && <Alert type="warning" showIcon message={`该用户 24 小时内已有 ${preview.recentCount} 笔调账申请，接近防刷上限。`} />}
          </Space>
        </Section>
      )}

      <ConfirmModal
        open={dialog === 'approve'}
        title="批准审批单"
        content={<p>批准后<b>系统将在同一事务内自动执行入账</b>，无需再手动执行；若入账失败（如余额不足），该单会置为「执行失败」并可重试，重试不会重复入账。</p>}
        onCancel={() => setDialog(null)}
        onOk={() => run(async () => {
          const r = await approvalApi.approve(detail.id)
          return r.status === 'EXECUTED' ? '已批准并执行：积分调整已入账（追加式流水，可按审批单 ID 反查）' : r.status === 'FAILED' ? '已批准，但执行失败（详见执行结果），可重试' : '已批准'
        }, '批准失败')}
      />
      <ConfirmModal
        open={dialog === 'reject'}
        danger
        title="拒绝审批单"
        okText="确认拒绝"
        content={<p>拒绝将留痕并结束该申请。</p>}
        reasonLabel="拒绝原因（写入审计日志）"
        onCancel={() => setDialog(null)}
        onOk={reason => run(async () => { await approvalApi.reject(detail.id, reason); return '已拒绝' }, '拒绝失败')}
      />
      <ConfirmModal
        open={dialog === 'execute'}
        danger
        title="重试执行调账"
        content={<p>该审批单此前执行失败（常见原因：用户余额不足以扣减），将重试入账：{formatPayload(detail.payload)}。执行与流水写入在同一事务中完成，<b>幂等</b>——重试不会重复入账。</p>}
        onCancel={() => setDialog(null)}
        onOk={() => run(async () => { await approvalApi.execute(detail.id); return '重试成功：积分调整已入账（追加式流水）' }, '执行失败')}
      />
    </PageStack>
  )
}

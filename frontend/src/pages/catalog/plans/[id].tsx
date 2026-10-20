/**
 * 套餐详情 / 编辑（/catalog/plans/:id）：基本信息、价格历史、编辑（影响预览 + 必填原因）。
 */

import { Alert, App, Button, Descriptions, Form, Input, InputNumber, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, PageStack, Section, errText, fmtTime, yuan } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { catalogApi, type PlanImpact } from '@/lib/catalog-api'
import { useAuthStore } from '@/stores/authStore'

interface Values { name: string, priceCents: number, monthlyCredits: number, maxFiles: number, reason: string }

export default function CatalogPlanDetailPage() {
  const { id } = useParams()
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [form] = Form.useForm<Values>()
  const [impact, setImpact] = useState<PlanImpact | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: plan, loading, error, reload } = useRequest(async () => {
    const d = await catalogApi.plan(id!)
    form.setFieldsValue({ name: d.name, priceCents: d.priceCents, monthlyCredits: d.monthlyCredits, maxFiles: d.maxFiles, reason: '' })
    setImpact(null)
    return d
  }, [id], '加载套餐详情失败')

  if (loading && !plan) return <Loading />
  if (!plan) return <div className="m-2"><ErrorAlert error={error ?? '套餐不存在'} /></div>

  const save = async (v: Values): Promise<void> => {
    setBusy(true)
    try {
      const r = await catalogApi.updatePlan(plan.id, { name: v.name, monthlyCredits: Number(v.monthlyCredits), priceCents: Number(v.priceCents), maxFiles: Number(v.maxFiles), reason: v.reason.trim() })
      message.success(r.priceChanged ? `已保存并调价：${yuan(v.priceCents)}（旧价 ${yuan(plan.priceCents)} 已存入价格历史）` : '已保存（价格未变化，未新增价格历史记录）')
      await reload()
    }
    catch (e) {
      message.error(errText(e, '保存失败'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <PageStack>
      <Section title={`套餐详情 · ${plan.name}`} extra={<Link to="/catalog/plans"><Button>返回列表</Button></Link>}>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="套餐 ID"><span className="font-mono">{plan.id}</span></Descriptions.Item>
          <Descriptions.Item label="状态">{plan.active ? <Tag color="success">在售</Tag> : <Tag>已下架</Tag>}</Descriptions.Item>
          <Descriptions.Item label="价格">{yuan(plan.priceCents)}</Descriptions.Item>
          <Descriptions.Item label="周期">{plan.periodMonths} 个月</Descriptions.Item>
          <Descriptions.Item label="持有用户">{plan.holderCount}</Descriptions.Item>
          <Descriptions.Item label="档位权限">{plan.costTierAccess.join(' / ') || '-'}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{fmtTime(plan.updatedAt)}</Descriptions.Item>
        </Descriptions>
      </Section>

      {plan.priceHistory && plan.priceHistory.length > 0 && (
        <Section title="价格历史">
          <Table
            rowKey="changedAt"
            size="small"
            pagination={false}
            dataSource={plan.priceHistory}
            columns={[
              { title: '变更时间', dataIndex: 'changedAt', render: fmtTime },
              { title: '变更前价格', dataIndex: 'priceCents', render: yuan },
              { title: '变更前月积分', dataIndex: 'monthlyCredits' },
              { title: '原因', dataIndex: 'reason', render: v => v ?? '-' },
            ]}
          />
        </Section>
      )}

      {canWrite && (
        <Section title="编辑套餐">
          <Alert type="warning" showIcon className="!mb-3" message={<><b>改价不影响已创建的订单</b>——订单创建时价格已固化为快照。本次改价只影响后续新订单与存量用户下次续费。</>} />
          <Form form={form} layout="vertical" className="max-w-2xl" onFinish={v => void save(v)}>
            <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="priceCents" label="价格（分）" extra="例如 1990 表示 ¥19.90"><InputNumber min={0} className="!w-full" /></Form.Item>
            <Form.Item name="monthlyCredits" label="月积分"><InputNumber min={0} className="!w-full" /></Form.Item>
            <Form.Item name="maxFiles" label="文件数上限"><InputNumber min={1} className="!w-full" /></Form.Item>
            <Space className="!mb-4">
              <Button onClick={() => void catalogApi.planImpact(plan.id, Number(form.getFieldValue('priceCents'))).then(setImpact).catch(e => message.error(errText(e, '影响预览失败')))}>预览改价影响</Button>
            </Space>
            {impact && (
              <Alert className="!mb-4" type="info" showIcon message={<>当前价 {yuan(impact.currentPriceCents)} → 新价 {yuan(impact.newPriceCents)}（月度收入变化 <b>{yuan(impact.monthlyRevenueDeltaCents)}</b>）<br />存量用户 {impact.holderCount} 名；待支付订单 {impact.pendingOrders} 笔（按旧快照结算，不受影响）。<br />{impact.note}</>} />
            )}
            <Form.Item name="reason" label="变更原因（必填，写入审计日志）" rules={[{ required: true, min: 2 }]}><Input placeholder="例如：季度调价促销" /></Form.Item>
            <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
          </Form>
        </Section>
      )}
    </PageStack>
  )
}

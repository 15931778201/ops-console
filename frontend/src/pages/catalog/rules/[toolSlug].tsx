/**
 * 计费规则详情 / 编辑（/catalog/rules/:toolSlug）：保存后规则版本自动递增；不追溯旧交易。
 */

import { Alert, App, Button, Descriptions, Form, Input, InputNumber, Space, Tag } from 'antd'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ErrorAlert, Loading, PageStack, Section, errText, fmtTime } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { catalogApi, type RuleImpact } from '@/lib/catalog-api'
import { useAuthStore } from '@/stores/authStore'

interface Values { creditCost: number, minPlan: string, maxFilesPerTask: number, reason: string }

export default function CatalogRuleDetailPage() {
  const { toolSlug } = useParams()
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('rule:write'))
  const [form] = Form.useForm<Values>()
  const [impact, setImpact] = useState<RuleImpact | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: rule, loading, error, reload } = useRequest(async () => {
    const hit = (await catalogApi.rules()).items.find(r => r.toolSlug === toolSlug)
    if (!hit) throw new Error('规则不存在')
    form.setFieldsValue({ creditCost: hit.creditCost, minPlan: hit.minPlan, maxFilesPerTask: hit.maxFilesPerTask, reason: '' })
    setImpact(null)
    return hit
  }, [toolSlug], '加载计费规则失败')

  if (loading && !rule) return <Loading />
  if (!rule) return <div className="m-2"><ErrorAlert error={error ?? '规则不存在'} /></div>

  const save = async (v: Values): Promise<void> => {
    setBusy(true)
    try {
      const r = await catalogApi.updateRule(rule.toolSlug, { creditCost: Number(v.creditCost), minPlan: v.minPlan, maxFilesPerTask: Number(v.maxFilesPerTask), reason: v.reason.trim() })
      message.success(r.ruleVersion === r.previousVersion ? '无实质变更，规则版本号未递增' : `${rule.toolSlug} 已更新：${r.previousVersion} → ${r.ruleVersion}`)
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
      <Section title={`规则详情 · ${rule.toolSlug}`} extra={<Link to="/catalog/rules"><Button>返回列表</Button></Link>}>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label="当前版本"><Tag color="processing">{rule.ruleVersion}</Tag></Descriptions.Item>
          <Descriptions.Item label="状态">{rule.active ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>}</Descriptions.Item>
          <Descriptions.Item label="积分消耗">{rule.creditCost}</Descriptions.Item>
          <Descriptions.Item label="最低套餐">{rule.minPlan}</Descriptions.Item>
          <Descriptions.Item label="单任务文件上限">{rule.maxFilesPerTask}</Descriptions.Item>
          <Descriptions.Item label="近 7 日用量">{rule.recentUsage.calls} 次 / {Math.abs(rule.recentUsage.credits)} 分</Descriptions.Item>
          <Descriptions.Item label="更新时间">{fmtTime(rule.updatedAt)}</Descriptions.Item>
        </Descriptions>
      </Section>

      {canWrite && (
        <Section title="编辑规则">
          <Form form={form} layout="vertical" className="max-w-2xl" onFinish={v => void save(v)}>
            <Form.Item name="creditCost" label="积分消耗"><InputNumber min={0} className="!w-full" /></Form.Item>
            <Form.Item name="minPlan" label="最低套餐"><Input /></Form.Item>
            <Form.Item name="maxFilesPerTask" label="单任务文件上限"><InputNumber min={1} className="!w-full" /></Form.Item>
            <Space className="!mb-4"><Button onClick={() => void catalogApi.ruleImpact(rule.toolSlug, Number(form.getFieldValue('creditCost'))).then(setImpact).catch(e => message.error(errText(e, '影响预览失败')))}>预览影响</Button></Space>
            {impact && <Alert className="!mb-4" type="info" showIcon message={<>当前 {impact.currentCreditCost} 分 → 新价 {impact.newCreditCost} 分（近 7 日预估扣费变化 <b>{impact.monthlyDeltaCredits} 分</b>）<br />近 7 日受影响用户 {impact.affectedUsers} 名、实扣 {impact.recentCredits} 分，按新价预估 {impact.projectedCredits} 分。<br />{impact.note}</>} />}
            <Form.Item name="reason" label="变更原因（必填，写入审计日志）" rules={[{ required: true, min: 2 }]}><Input /></Form.Item>
            <Button type="primary" htmlType="submit" loading={busy}>保存（版本自动递增）</Button>
          </Form>
        </Section>
      )}
    </PageStack>
  )
}

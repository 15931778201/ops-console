/** 套餐新增 / 编辑共用表单（改价不追溯已创建订单）。 */

import { Button, Form, Input, InputNumber, Space } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ErrorAlert, Section, errText } from '@/components/page'
import { productApi, type Product, type ProductPlan } from '@/lib/product-api'

interface Values { name: string, periodMonths: number, priceCents: number, monthlyCredits: number, featuresText: string }

export default function PlanForm({ product, plan }: { product: Product, plan?: ProductPlan }) {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const back = `/products/plans?pid=${product.id}`

  const save = async (v: Values): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await productApi.savePlan(product.id, {
        ...(plan ? { id: plan.id } : {}),
        name: v.name,
        periodMonths: Number(v.periodMonths),
        priceCents: Number(v.priceCents),
        monthlyCredits: Number(v.monthlyCredits),
        features: (v.featuresText ?? '').split('\n').map(s => s.trim()).filter(Boolean),
        active: plan ? plan.active : true,
      })
      navigate(back)
    }
    catch (e) {
      setError(errText(e, '保存失败'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <Section title={plan ? `编辑套餐 · ${plan.name}` : '新增套餐'}>
      <div className="mb-3 text-sm opacity-70">改价不追溯已创建订单。</div>
      <ErrorAlert error={error} />
      <Form
        layout="vertical"
        className="max-w-2xl"
        initialValues={plan ? { ...plan, featuresText: plan.features.join('\n') } : { periodMonths: 1, priceCents: 0, monthlyCredits: 0, featuresText: '' }}
        onFinish={v => void save(v)}
      >
        <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="periodMonths" label="周期（月）"><InputNumber min={1} className="!w-full" /></Form.Item>
        <Form.Item name="priceCents" label="价格（分）" extra="1990 表示 ¥19.90"><InputNumber min={0} className="!w-full" /></Form.Item>
        <Form.Item name="monthlyCredits" label="月积分"><InputNumber min={0} className="!w-full" /></Form.Item>
        <Form.Item name="featuresText" label="权益列表" extra="每行一条"><Input.TextArea rows={4} /></Form.Item>
        <Space><Button onClick={() => navigate(back)}>取消</Button><Button type="primary" htmlType="submit" loading={busy}>保存</Button></Space>
      </Form>
    </Section>
  )
}

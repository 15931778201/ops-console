/** 新建 / 编辑产品共用表单（路由页：/products/new、/products/:id/edit）。 */

import { Button, Form, Input, Space } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ErrorAlert, errText } from '@/components/page'
import { productApi } from '@/lib/product-api'

interface Values { code: string, name: string, category: string, description: string }

export default function ProductForm({ id, initial }: { id?: string, initial?: Values }) {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (v: Values): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (id) {
        await productApi.update(id, { name: v.name, category: v.category, description: v.description ?? '' })
        navigate(`/products/${id}`)
      }
      else {
        const created = await productApi.create({ code: v.code, name: v.name, category: v.category, description: v.description ?? '' })
        navigate(`/products/${created.id}`)
      }
    }
    catch (e) {
      setError(errText(e, '保存失败'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ErrorAlert error={error} />
      <Form layout="vertical" className="max-w-xl" initialValues={initial} onFinish={v => void save(v)}>
        <Form.Item name="code" label="产品编码" extra="小写字母/数字/连字符，创建后不可改" rules={id ? [] : [{ required: true, pattern: /^[a-z0-9-]{2,32}$/, message: '2-32 位小写字母/数字/连字符' }]}>
          <Input disabled={!!id} />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="category" label="分类" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="description" label="简介"><Input.TextArea rows={3} /></Form.Item>
        <Space>
          <Button onClick={() => navigate(-1)}>取消</Button>
          <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
        </Space>
      </Form>
    </>
  )
}

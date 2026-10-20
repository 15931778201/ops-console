/**
 * 发布新版本（/products/versions/new?pid=）。
 */

import { Button, Checkbox, Form, Input, Select, Space } from 'antd'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ErrorAlert, Section, errText } from '@/components/page'
import { RichTextEditor, htmlToText } from '@/components/rich-text'
import { productApi, type Channel, type Platform, type Product } from '@/lib/product-api'

import { ProductScope } from '../components/scope'

interface Values { version: string, platform: Platform, channel: Channel, changelog: string, downloadUrl: string, forceUpdate: boolean, minSupported: string }

function PublishForm({ product }: { product: Product }) {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const back = `/products/versions?pid=${product.id}`

  const publish = async (v: Values): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await productApi.publishVersion(product.id, { ...v, forceUpdate: !!v.forceUpdate, minSupported: v.minSupported ?? '' })
      navigate(back)
    }
    catch (e) {
      setError(errText(e, '发布失败'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <Section title="发布新版本">
      <ErrorAlert error={error} />
      <Form layout="vertical" className="max-w-3xl" initialValues={{ platform: 'windows', channel: 'stable', changelog: '', forceUpdate: false }} onFinish={v => void publish(v)}>
        <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
          <Form.Item name="version" label="版本号" extra="x.y.z" rules={[{ required: true, pattern: /^\d+\.\d+\.\d+$/, message: '格式应为 x.y.z' }]}><Input /></Form.Item>
          <Form.Item name="platform" label="平台"><Select options={['windows', 'macos', 'linux', 'web'].map(v => ({ value: v, label: v }))} /></Form.Item>
          <Form.Item name="channel" label="渠道"><Select options={[{ value: 'stable', label: 'stable' }, { value: 'beta', label: 'beta' }]} /></Form.Item>
          <Form.Item name="minSupported" label="最低支持版本" extra="低于该版本且勾选强更时强制升级"><Input /></Form.Item>
        </div>
        <Form.Item name="downloadUrl" label="下载地址" rules={[{ required: true, pattern: /^https?:\/\//, message: '需以 http(s):// 开头' }]}><Input placeholder="https://" /></Form.Item>
        <Form.Item name="changelog" label="更新内容" rules={[{ validator: (_, v) => (htmlToText(v ?? '') ? Promise.resolve() : Promise.reject(new Error('请填写更新内容'))) }]}><RichTextEditor /></Form.Item>
        <Form.Item name="forceUpdate" valuePropName="checked"><Checkbox>强制更新</Checkbox></Form.Item>
        <Space><Button onClick={() => navigate(back)}>取消</Button><Button type="primary" htmlType="submit" loading={busy}>发布</Button></Space>
      </Form>
    </Section>
  )
}

export default function VersionPublishPage() {
  return <ProductScope>{p => <PublishForm product={p} />}</ProductScope>
}

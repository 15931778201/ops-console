/**
 * 产品上线配置（/products/release?pid=）：公告 / 产品说明（两个独立富文本）、客服信息、官网链接、试用期限、特殊参数。
 */

import { Button, Checkbox, Form, Input, InputNumber, Space, App } from 'antd'
import { useState } from 'react'

import { ErrorAlert, Loading, Section, errText } from '@/components/page'
import { RichTextEditor } from '@/components/rich-text'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product, type ReleaseConfig } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { ProductScope } from './components/scope'

const url = (label: string) => ({ pattern: /^$|^https?:\/\//, message: `${label}需以 http(s):// 开头` })

function ReleaseForm({ product }: { product: Product }) {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [form] = Form.useForm<ReleaseConfig>()
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState('')

  const { data: cfg, loading, error } = useRequest(async () => {
    const c = await productApi.release(product.id)
    form.setFieldsValue(c)
    return c
  }, [product.id], '加载上线配置失败')

  if (loading && !cfg) return <Loading />
  if (!cfg) return <ErrorAlert error={error} />

  const save = async (v: ReleaseConfig): Promise<void> => {
    setBusy(true)
    setSaveError('')
    try {
      const { productId: _a, onlineAt: _b, status: _c, ...rest } = { ...cfg, ...v }
      await productApi.saveRelease(product.id, { ...rest, status: cfg.status })
      message.success('上线配置已保存')
    }
    catch (e) {
      setSaveError(errText(e, '保存失败'))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <Form form={form} layout="vertical" disabled={!canWrite} onFinish={v => void save(v)} initialValues={cfg}>
      <ErrorAlert error={saveError} />
      <div className="flex flex-col gap-2">
        <Section title="公告" extra={<span className="text-xs opacity-60">维护通知、活动提示等临时信息</span>}>
          <Form.Item name="maintenanceNotice" extra="非空时用户端展示；留空不展示" noStyle={false}>
            <RichTextEditor disabled={!canWrite} />
          </Form.Item>
        </Section>

        <Section title="产品说明" extra={<span className="text-xs opacity-60">产品介绍、功能亮点等长期展示内容</span>}>
          <Form.Item name="productIntro" extra="非空时用户端展示；留空不展示">
            <RichTextEditor disabled={!canWrite} />
          </Form.Item>
        </Section>

        <Section title="客服信息" extra={<span className="text-xs opacity-60">用户端「联系客服」入口展示的渠道</span>}>
          <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
            <Form.Item name={['service', 'email']} label="客服邮箱"><Input /></Form.Item>
            <Form.Item name={['service', 'phone']} label="客服电话"><Input /></Form.Item>
            <Form.Item name={['service', 'wechat']} label="客服微信"><Input /></Form.Item>
            <Form.Item name={['service', 'hours']} label="服务时间"><Input /></Form.Item>
            <Form.Item name={['service', 'helpUrl']} label="帮助中心地址" rules={[url('帮助中心地址')]}><Input placeholder="https://" /></Form.Item>
          </div>
        </Section>

        <Section title="官网链接">
          <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2">
            <Form.Item name={['website', 'homepage']} label="官网首页" rules={[url('官网首页')]}><Input placeholder="https://" /></Form.Item>
            <Form.Item name={['website', 'downloadPage']} label="下载页" rules={[url('下载页')]}><Input placeholder="https://" /></Form.Item>
            <Form.Item name={['website', 'privacyUrl']} label="隐私政策" rules={[url('隐私政策')]}><Input placeholder="https://" /></Form.Item>
            <Form.Item name={['website', 'termsUrl']} label="服务条款" rules={[url('服务条款')]}><Input placeholder="https://" /></Form.Item>
          </div>
        </Section>

        <Section title="试用期限" extra={<span className="text-xs opacity-60">新用户首次使用时发放；修改仅影响之后开始的试用</span>}>
          <Form.Item name={['trial', 'enabled']} valuePropName="checked"><Checkbox>开启试用</Checkbox></Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.trial?.enabled !== b.trial?.enabled}>
            {({ getFieldValue }) => getFieldValue(['trial', 'enabled']) && (
              <div className="grid grid-cols-1 gap-x-4 md:grid-cols-3">
                <Form.Item name={['trial', 'days']} label="试用天数" extra="1-90"><InputNumber min={1} max={90} className="!w-full" /></Form.Item>
                <Form.Item name={['trial', 'credits']} label="试用赠送积分"><InputNumber min={0} className="!w-full" /></Form.Item>
                <Form.Item name={['trial', 'oncePerUser']} valuePropName="checked" label=" "><Checkbox>每用户仅限一次</Checkbox></Form.Item>
              </div>
            )}
          </Form.Item>
        </Section>

        <Section title="特殊参数" extra={<span className="text-xs opacity-60">随配置下发给客户端的键值（如 maxUploadMb）；键不可重复</span>}>
          <Form.List name="params">
            {(fields, { add, remove }) => (
              <>
                {fields.map(f => (
                  <Space key={f.key} align="baseline" className="flex">
                    <Form.Item name={[f.name, 'key']} rules={[{ required: true, message: '键必填' }]}><Input placeholder="键" /></Form.Item>
                    <Form.Item name={[f.name, 'value']}><Input placeholder="值" /></Form.Item>
                    <Form.Item name={[f.name, 'remark']}><Input placeholder="备注" /></Form.Item>
                    {canWrite && <Button size="small" onClick={() => remove(f.name)}>删除</Button>}
                  </Space>
                ))}
                {canWrite && <Button size="small" onClick={() => add({ key: '', value: '', remark: '' })}>添加参数</Button>}
              </>
            )}
          </Form.List>
        </Section>

        {canWrite && <div><Button type="primary" htmlType="submit" loading={busy}>保存配置</Button></div>}
      </div>
    </Form>
  )
}

export default function ProductReleasePage() {
  return <ProductScope>{p => <ReleaseForm product={p} />}</ProductScope>
}

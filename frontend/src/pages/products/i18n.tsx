/**
 * 产品多语言配置（/products/i18n?pid=）：每个语言一份展示文案；未配置的语言回退到简体中文。
 */

import { App, Button, Form, Input, Tabs } from 'antd'
import { useState } from 'react'

import { ErrorAlert, Loading, Section, errText } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { LOCALES, productApi, type Locale, type Product, type ProductI18n } from '@/lib/product-api'
import { useAuthStore } from '@/stores/authStore'

import { ProductScope } from './components/scope'

function LocaleForm({ product, locale, saved, onSaved }: { product: Product, locale: Locale, saved?: ProductI18n, onSaved: (v: ProductI18n) => void }) {
  const { message } = App.useApp()
  const canWrite = useAuthStore(s => s.has('plan:write'))
  const [busy, setBusy] = useState(false)

  return (
    <Form
      layout="vertical"
      className="max-w-2xl"
      disabled={!canWrite}
      initialValues={saved ?? { locale, name: '', tagline: '', description: '' }}
      onFinish={async (v) => {
        setBusy(true)
        try {
          const r = await productApi.saveI18n(product.id, { ...v, locale })
          onSaved(r)
          message.success(`${LOCALES.find(l => l.code === locale)?.label} 文案已保存`)
        }
        catch (e) {
          message.error(errText(e, '保存失败'))
        }
        finally {
          setBusy(false)
        }
      }}
    >
      <Form.Item name="name" label="产品名称" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="tagline" label="一句话标语"><Input /></Form.Item>
      <Form.Item name="description" label="详细介绍"><Input.TextArea rows={5} /></Form.Item>
      {canWrite && <Button type="primary" htmlType="submit" loading={busy}>保存</Button>}
    </Form>
  )
}

function I18nView({ product }: { product: Product }) {
  const { data, setData, loading, error } = useRequest(() => productApi.i18n(product.id), [product.id], '加载多语言失败')

  if (loading && !data) return <Loading />
  if (!data) return <ErrorAlert error={error} />

  return (
    <Section title="展示文案" extra={<span className="text-xs opacity-60">未配置的语言回退到简体中文</span>}>
      <Tabs
        items={LOCALES.map((l) => {
          const saved = data.find(i => i.locale === l.code)
          return {
            key: l.code,
            label: <>{l.label}<span className="text-xs opacity-60">{saved?.name ? ' ✓' : '（未配置）'}</span></>,
            children: <LocaleForm key={`${l.code}-${saved?.name ?? ''}`} product={product} locale={l.code} saved={saved} onSaved={v => setData(cur => [...(cur ?? []).filter(i => i.locale !== v.locale), v])} />,
          }
        })}
      />
    </Section>
  )
}

export default function ProductI18nPage() {
  return <ProductScope>{p => <I18nView product={p} />}</ProductScope>
}

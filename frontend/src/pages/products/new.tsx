import { PageCard } from '@/components/page'

import ProductForm from './components/ProductForm'

export default function ProductCreatePage() {
  return (
    <PageCard title="新建产品">
      <div className="mb-3 text-sm opacity-70">创建后为草稿状态，请到「上线配置」上线。</div>
      <ProductForm />
    </PageCard>
  )
}

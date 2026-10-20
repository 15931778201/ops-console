import { useParams } from 'react-router-dom'

import { ErrorAlert, Loading, PageCard } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi } from '@/lib/product-api'

import ProductForm from '../components/ProductForm'

export default function ProductEditPage() {
  const { id } = useParams()
  const { data: p, loading, error } = useRequest(async () => {
    const hit = (await productApi.list()).find(x => x.id === id)
    if (!hit) throw new Error('产品不存在')
    return hit
  }, [id], '加载产品失败')

  if (loading && !p) return <Loading />
  if (!p) return <div className="m-2"><ErrorAlert error={error ?? '产品不存在'} /></div>

  return (
    <PageCard title={`编辑产品 · ${p.name}`}>
      <ProductForm id={p.id} initial={{ code: p.code, name: p.name, category: p.category, description: p.description }} />
    </PageCard>
  )
}

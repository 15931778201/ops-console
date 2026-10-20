import { useParams } from 'react-router-dom'

import { ErrorAlert, Loading } from '@/components/page'
import { useRequest } from '@/hooks/useRequest'
import { productApi, type Product } from '@/lib/product-api'

import { ProductScope } from '../../components/scope'
import PlanForm from '../components/PlanForm'

function Edit({ product }: { product: Product }) {
  const { planId } = useParams()
  const { data: plan, loading, error } = useRequest(async () => {
    const hit = (await productApi.plans(product.id)).find(x => x.id === planId)
    if (!hit) throw new Error('套餐不存在')
    return hit
  }, [product.id, planId], '加载套餐失败')

  if (loading && !plan) return <Loading />
  if (!plan) return <ErrorAlert error={error} />
  return <PlanForm product={product} plan={plan} />
}

export default function PlanEditPage() {
  return <ProductScope>{p => <Edit product={p} />}</ProductScope>
}

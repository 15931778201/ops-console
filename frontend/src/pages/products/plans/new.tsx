import { ProductScope } from '../components/scope'
import PlanForm from './components/PlanForm'

export default function PlanCreatePage() {
  return <ProductScope>{p => <PlanForm product={p} />}</ProductScope>
}

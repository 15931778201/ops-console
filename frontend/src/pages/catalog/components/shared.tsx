import { Segmented } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'

/** 套餐管理 / 计费规则 两个独立页面之间的切换 */
export function CatalogTabs() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <Segmented
      value={pathname.startsWith('/catalog/rules') ? '/catalog/rules' : '/catalog/plans'}
      onChange={v => navigate(v as string)}
      options={[{ value: '/catalog/plans', label: '套餐管理' }, { value: '/catalog/rules', label: '计费规则' }]}
    />
  )
}

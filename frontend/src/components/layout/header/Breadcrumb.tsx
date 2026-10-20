import { Breadcrumb } from 'antd'
import { useMemo } from 'react'
import { Link, useLocation, useMatches } from 'react-router-dom'

import { MENU_GROUPS } from '@/constants/menu'
import { getBreadcrumb, getMenuPath, getRouteMeta } from '@/router/routeMeta'

/** 将 `/users/:id` 之类的模式按当前路由参数还原为可跳转的真实路径 */
function fill(pattern: string, params: Record<string, string | undefined>): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_, k: string) => params[k] ?? '')
}

export default function BreadcrumbNav() {
  const location = useLocation()
  // Layout 是页面的父路由，useParams 拿不到子路由参数；取最深一层匹配的 params
  const matches = useMatches()
  const params = matches[matches.length - 1]?.params ?? {}

  const items = useMemo(() => {
    const meta = getRouteMeta(location.pathname)
    const chain = getBreadcrumb(meta)
    const menuPath = getMenuPath(meta)
    const group = MENU_GROUPS.find(g => g.children.some(c => c.path === menuPath))
    const crumbs = chain.map((m, i) => {
      const isLast = i === chain.length - 1
      const to = fill(m.path, params)
      return { title: isLast ? m.title : <Link to={to} viewTransition>{m.title}</Link> }
    })
    return group ? [{ title: group.title }, ...crumbs] : crumbs
  }, [location.pathname, params])

  return <Breadcrumb items={items} />
}

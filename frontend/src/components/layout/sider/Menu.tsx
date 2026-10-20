import type { MenuProps } from 'antd'

import { Menu as AntdMenu } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { MENU_GROUPS } from '@/constants/menu'
import { getMenuPath, getRouteMeta } from '@/router/routeMeta'
import { useAuthStore } from '@/stores/authStore'

import styles from './Menu.module.scss'

export default function Menu() {
  const navigate = useNavigate()
  const location = useLocation()
  const permissions = useAuthStore(s => s.permissions)

  // 按权限过滤；只剩一个叶子的分组仍保留分组，保持导航结构稳定
  const visible = useMemo(
    () =>
      MENU_GROUPS.map(g => ({
        ...g,
        children: g.children.filter(i => i.perms.length === 0 || i.perms.some(p => permissions.includes(p))),
      })).filter(g => g.children.length > 0),
    [permissions],
  )

  const selectedPath = getMenuPath(getRouteMeta(location.pathname))
  const openKey = visible.find(g => g.children.some(i => i.path === selectedPath))?.key

  // 受控展开：路由切换时自动展开当前页所属分组，同时保留用户手动展开的分组
  const [openKeys, setOpenKeys] = useState<string[]>(openKey ? [openKey] : [])
  useEffect(() => {
    if (openKey) setOpenKeys(keys => (keys.includes(openKey) ? keys : [...keys, openKey]))
  }, [openKey])

  const items: MenuProps['items'] = visible.map(g => ({
    key: g.key,
    icon: g.icon,
    label: <span className="text-sm">{g.title}</span>,
    children: g.children.map(i => ({
      key: i.path,
      label: <span className="text-sm">{i.title}</span>,
    })),
  }))

  const handleClick: MenuProps['onClick'] = ({ key }) => {
    if (key !== location.pathname) navigate(key, { viewTransition: true })
  }

  return (
    <AntdMenu
      items={items}
      openKeys={openKeys}
      onOpenChange={setOpenKeys}
      selectedKeys={selectedPath ? [selectedPath] : []}
      className={`${styles.menuWrapper} !border-r-0`}
      mode="inline"
      onClick={handleClick}
    />
  )
}

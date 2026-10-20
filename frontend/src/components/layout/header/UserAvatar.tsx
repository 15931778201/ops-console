import type { MenuProps } from 'antd'

import { App, Button, Dropdown, Tag } from 'antd'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/icon'
import { ROLE_LABELS } from '@/lib/permissions'
import { useAuthStore } from '@/stores/authStore'

export default function UserDropdown() {
  const navigate = useNavigate()
  const admin = useAuthStore(s => s.admin)
  const logout = useAuthStore(s => s.logout)
  const { modal } = App.useApp()

  const items: MenuProps['items'] = [
    {
      key: 'security',
      label: '我的安全设置',
      icon: <Icon icon="icon-park-outline:user" className="mr-0.5" />,
      onClick: () => navigate('/settings/security', { viewTransition: true }),
    },
    {
      key: 'logout',
      label: '退出登录',
      icon: <Icon icon="icon-park-outline:logout" className="mr-0.5" />,
      onClick: () => {
        modal.confirm({
          title: '确认退出登录？',
          onOk: async () => {
            await logout()
            navigate('/login', { replace: true })
          },
        })
      },
    },
  ]

  return (
    <div className="flex items-center gap-1">
      {admin && <Tag color={admin.role === 'SUPER_ADMIN' ? 'red' : 'blue'} className="!mr-0">{ROLE_LABELS[admin.role]}</Tag>}
      <Dropdown placement="bottomRight" menu={{ items }}>
        <Button
          type="text"
          icon={<Icon icon="icon-park-outline:user" className="text-base dark:text-theme-dark text-theme" />}
        >
          <span className="pl-2 font-400">{admin?.name || admin?.username}</span>
        </Button>
      </Dropdown>
    </div>
  )
}

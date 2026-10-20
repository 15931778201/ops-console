import { Button } from 'antd'
import { useShallow } from 'zustand/react/shallow'

import { Icon } from '@/components/icon'
import { useAppStore } from '@/stores/appStore'

export default function SidebarToggle() {
  const { sidebarCollapsed, toggleSidebarCollapsed } = useAppStore(
    useShallow(state => ({
      sidebarCollapsed: state.sidebarCollapsed,
      toggleSidebarCollapsed: state.toggleSidebarCollapsed,
    })),
  )

  function handleClick() {
    toggleSidebarCollapsed()
  }

  return (
    <div className="w-10">
      <Button
        type="text"
        block
        onClick={handleClick}
        icon={(
          <Icon
            icon={sidebarCollapsed ? 'icon-park-outline:menu-unfold' : 'icon-park-outline:menu-fold'}
            className="text-base dark:text-theme-dark text-theme"
          />
        )}
      />
    </div>
  )
}

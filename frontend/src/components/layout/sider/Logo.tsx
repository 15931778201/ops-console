import { useLocation, useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'

import { Icon } from '@/components/icon'
import { useAppStore } from '@/stores/appStore'

export default function Logo() {
  const navigate = useNavigate()
  const location = useLocation()
  const { headerHeight, sidebarCollapsed } = useAppStore(
    useShallow(state => ({
      headerHeight: state.headerHeight,
      sidebarCollapsed: state.sidebarCollapsed,
    })),
  )

  const logoStyle = {
    height: `${headerHeight}px`,
  }

  function handleClick() {
    console.log(location.pathname)
    if (location.pathname !== '/') {
      navigate('/', { viewTransition: true })
    }
  }

  return (
    <div
      className="flex cursor-pointer select-none items-center justify-center gap-3 dark:text-theme-dark text-theme"
      style={logoStyle}
      onClick={handleClick}
    >
      <Icon icon="icon-local:logo" className="text-3xl" />
      {!sidebarCollapsed && (
        <h2
          className="mb-0 block overflow-hidden whitespace-nowrap text-xl font-bold"
        >
          {import.meta.env.VITE_APP_TITLE}
        </h2>
      )}
    </div>
  )
}

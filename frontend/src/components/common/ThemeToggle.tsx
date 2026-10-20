import { Button } from 'antd'

import { Icon } from '@/components/icon'
import { useAnimateTheme } from '@/hooks/useAnimateTheme'

interface ThemeToggleProps {
  animate?: boolean
}

export default function ThemeToggle({
  animate = true,
}: ThemeToggleProps) {
  const {
    triggerRef,
    isDark,
    isLoading,
    toggleTheme,
    animateToggleTheme,
  } = useAnimateTheme()

  const handleClick = () => {
    if (animate) {
      animateToggleTheme()
    }
    else {
      toggleTheme()
    }
  }

  return (
    <div className="w-10">
      <Button
        ref={triggerRef}
        type="text"
        block
        disabled={isLoading}
        onClick={handleClick}
        icon={(
          <Icon
            icon={isDark ? 'icon-park-outline:moon' : 'icon-park-outline:sun'}
            className="text-base dark:text-theme-dark text-theme"
          />
        )}
      />
    </div>
  )
}

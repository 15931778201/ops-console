import { Layout } from 'antd'
import { useShallow } from 'zustand/react/shallow'

import { ThemeToggle } from '@/components/common'
import { useAppStore } from '@/stores/appStore'

import Breadcrumb from './Breadcrumb'
import SiderToggle from './SiderToggle'
import UserAvatar from './UserAvatar'

const { Header: AntdHeader } = Layout

export default function Header() {
  // 从应用store获取header高度
  const { headerHeight } = useAppStore(
    useShallow(state => ({
      headerHeight: state.headerHeight,
    })),
  )

  const style = {
    height: `${headerHeight}px`,
    lineHeight: `${headerHeight}px`,
    paddingInline: 0,
  }

  return (
    <AntdHeader style={style}>
      <div className="h-full flex items-center justify-between border-light-500 border-b-solid bg-theme-layout dark:bg-theme-layout-dark px-3 dark:border-dark-700">
        <div className="flex items-center gap-2">
          <SiderToggle />
          <Breadcrumb />
        </div>
        <div className="flex items-center justify-end">
          <ThemeToggle />
          <UserAvatar />
        </div>
      </div>
    </AntdHeader>
  )
}

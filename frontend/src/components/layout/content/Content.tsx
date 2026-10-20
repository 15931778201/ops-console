import type { ReactNode } from 'react'

import { Layout } from 'antd'
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@/stores/appStore'
import { scrollbarOptions } from '@/utils/overlayscrollbars'

const { Content: AntdContent } = Layout

interface ScrollableContentProps {
  children?: ReactNode
}

export default function Content({ children }: ScrollableContentProps) {
  const { headerHeight } = useAppStore(
    useShallow(state => ({
      headerHeight: state.headerHeight,
    })),
  )

  return (
    <AntdContent
      style={{ height: `calc(100vh - ${headerHeight}px)` }}
      className="bg-theme-content dark:bg-theme-content-dark"
    >
      <OverlayScrollbarsComponent
        options={scrollbarOptions}
        defer
        className="h-full bg-theme-content dark:bg-theme-content-dark"
      >
        {children}
      </OverlayScrollbarsComponent>
    </AntdContent>
  )
}

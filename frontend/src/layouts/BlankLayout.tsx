import type { ReactNode } from 'react'

interface BlankLayoutProps {
  children: ReactNode
}

export default function BlankLayout({ children }: BlankLayoutProps) {
  return (
    <div className="bg-theme-layout dark:bg-theme-layout-dark dark:text-theme-dark text-theme">
      {children}
    </div>
  )
}

import type { ReactNode } from 'react'

import { Layout } from 'antd'

import { Content, Header, Sider } from '@/components/layout'

interface BaseLayoutProps {
  children: ReactNode
}

export default function BaseLayout({ children }: BaseLayoutProps) {
  return (
    <Layout>
      <Sider />
      <Layout>
        <Header />
        <Content>
          {children}
        </Content>
      </Layout>
    </Layout>
  )
}

import { App as AntdApp } from 'antd'
import 'virtual:uno.css'

import { ThemeProvider, TransitionProvider } from '@/contexts'

import Router from './router'

export default function App() {
  return (
    <AntdApp>
      <ThemeProvider>
        <TransitionProvider>
          <Router />
        </TransitionProvider>
      </ThemeProvider>
    </AntdApp>
  )
}

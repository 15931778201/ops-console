import { StrictMode } from 'react'
import '@ant-design/v5-patch-for-react-19'
import 'antd/dist/reset.css'
import 'virtual:uno.css'
import 'virtual:local-icons'
import { createRoot } from 'react-dom/client'

import '@/assets/styles/page-transition.scss'
import './App.css'
import { setupIconifyOffline, setupLoading } from '@/plugins'

import App from './App.tsx'

setupLoading()
setupIconifyOffline()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * ECharts 轻封装：按需引入（tree-shaking）以控制体积，随容器尺寸自适应，卸载时销毁实例。
 */

import type { EChartsCoreOption } from 'echarts/core'

import { BarChart, FunnelChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  FunnelChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
])

export function EChart({ option, height = 300, label }: { option: EChartsCoreOption, height?: number, label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const c = echarts.init(el)
    chart.current = c
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => c.resize()) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      c.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} role="img" aria-label={label} style={{ width: '100%', height }} />
}

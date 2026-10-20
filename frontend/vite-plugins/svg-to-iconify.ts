import type { Plugin } from 'vite'

import { cleanupSVG, importDirectory, isEmptyColor, parseColors, runSVGO } from '@iconify/tools'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { generateTypeFileHeader } from './helper'

export default function svgToIconify(
  {
    svgDir = 'src/assets/svg-icon',
    prefix = 'icon-local',
    dts = 'virtual-local-icons.d.ts',
  },
): Plugin {
  const virtualModuleId = 'virtual:local-icons'
  const resolvedVirtualModuleId = `\0${virtualModuleId}`

  const pluginName = 'vite-plugin-svg-to-iconify'
  let lastUpdated: number | null = null

  return {
    name: pluginName,

    configureServer(server) {
      server.watcher.add(svgDir)
      server.watcher.on('change', async (file) => {
        if (file.endsWith('.svg')) {
          // 获取更新时间戳
          const stats = statSync(file)
          const updated = stats.mtimeMs

          // 避免重复更新
          if (updated !== lastUpdated) {
            lastUpdated = updated

            // 手动触发模块更新
            const module = server.moduleGraph.getModuleById(resolvedVirtualModuleId)
            if (module) {
              server.moduleGraph.invalidateModule(module)
              server.ws.send({
                type: 'update',
                updates: [
                  {
                    type: 'js-update',
                    path: resolvedVirtualModuleId,
                    acceptedPath: resolvedVirtualModuleId,
                    timestamp: updated,
                  },
                ],
              })
            }
          }
        }
      })
    },

    resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId
      }
    },

    configResolved() {
      // 确保类型声明文件目录存在
      // const typesDir = path.resolve(config.root, 'types')
      const outputDir = path.dirname(dts)
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true })
      }

      // 生成类型声明文件
      const dtsContent = `${generateTypeFileHeader(pluginName)}
declare module 'virtual:local-icons' {
  export const icons: string[]
}`

      writeFileSync(
        dts,
        dtsContent,
      )
    },

    async load(id) {
      if (id === resolvedVirtualModuleId) {
        // const svgDir = path.resolve(process.cwd(), svgDir)

        // 读取所有 SVG 文件
        const iconSet = await importDirectory(svgDir, {
          prefix,
        })
        iconSet.forEach((name, type) => {
          if (type !== 'icon') {
            return
          }

          const svg = iconSet.toSVG(name)
          if (!svg) {
            // 无效图标
            iconSet.remove(name)
            return
          }
          // 清理和优化图标
          try {
            // 清理图标代码
            cleanupSVG(svg)

            // 假设图标是单色的：用 currentColor 替换颜色，如果缺失则添加
            // 如果图标不是单色的，请删除此代码
            parseColors(svg, {
              defaultColor: 'currentColor',
              callback: (_attr, colorStr, color) => {
                return !color || isEmptyColor(color)
                  ? colorStr
                  : 'currentColor'
              },
            })

            // 优化图标
            runSVGO(svg)
          }
          catch (err) {
            // 无效图标
            console.error(`Error parsing ${name}:`, err)
            iconSet.remove(name)
            return
          }

          // 更新图标
          iconSet.fromSVG(name, svg)
        })

        // 导出图标数据
        const exported = iconSet.export()

        const localIconSet = {
          ...exported,
          prefix,
        }

        // 生成虚拟模块代码
        return `
import { addCollection } from '@iconify/react'

const iconSet = ${JSON.stringify(localIconSet)}
addCollection(iconSet)

// export icon list for type hinting
export const icons = ${JSON.stringify(Object.keys(localIconSet.icons).map(name => `${prefix}:${name}`))}
`
      }
    },
  }
}

import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import UnoCSS from 'unocss/vite'
import { defineConfig, loadEnv } from 'vite'
import viteCompression from 'vite-plugin-compression'
import Pages from 'vite-plugin-pages'

import { svgToIconify } from './vite-plugins'

// import { getRouteMeta } from './src/router/routeMeta'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())

  const { VITE_PORT, VITE_BASE_URL } = env

  return {
    base: VITE_BASE_URL,
    server: {
      port: Number.parseInt(VITE_PORT),
      proxy: {
        '/api': { target: env.VITE_PROXY_TARGET || 'http://127.0.0.1:3001', changeOrigin: true },
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom', 'zustand'],
            antd: ['antd'],
            echarts: ['echarts'],
          },
          chunkFileNames: 'assets/js/[name]-[hash].js',
          entryFileNames: 'assets/js/[name]-[hash].js',
          assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
        },
      },
    },
    plugins: [
      Pages({
        exclude: ['**/component{,s}/**'],
      }),
      react(),
      UnoCSS(),
      svgToIconify({
        svgDir: fileURLToPath(new URL('./src/assets/svg-icon', import.meta.url)),
        prefix: 'icon-local',
        dts: fileURLToPath(new URL('./types/virtual-local-icons.d.ts', import.meta.url)),
      }),
      viteCompression({
        verbose: true, // 是否在控制台输出压缩结果
        disable: false, // 是否禁用
        threshold: 1024, // 体积大于阈值会被压缩，单位为 b，默认为 1kb
        algorithm: 'gzip', // 压缩算法，可选 ['gzip','brotliCompress','deflate','deflateRaw']
        ext: '.gz', // 生成的压缩包后缀
        deleteOriginFile: false, // 是否删除原文件，默认为 false
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  }
})

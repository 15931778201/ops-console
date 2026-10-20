import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    env: { VITE_API_MOCK: 'false' },
    include: ['src/**/*.test.{ts,tsx}'],
  },
})

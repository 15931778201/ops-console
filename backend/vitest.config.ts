import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './node_modules/.vitest-cache',
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // 测试环境注入最小配置，避免 config 模块 fail-fast 退出
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/heyu_test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-32',
    },
  },
});

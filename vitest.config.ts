import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // 输出 JSON 供 scripts/badge.mjs 生成 tests 徽章（真实测试数）
    reporters: ['default', ['json', { outputFile: 'test-results.json' }]],
    coverage: {
      provider: 'v8',
      // 全 src 口径（含 GlobeViewer 等当前 0% 文件），不玩数字游戏
      include: ['src/**/*.{ts,tsx}'],
      // 入口壳与测试基建不计入业务覆盖率
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/App.tsx', 'src/globe/viewport/dataWorker.ts', 'src/globe/facade/primitive.ts'],
      reporter: ['text', 'json-summary', 'json', 'html'],
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 85,
        branches: 70,
      },
    },
  },
})

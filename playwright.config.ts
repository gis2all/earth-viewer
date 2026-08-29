import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90000,
  workers: 1,
  retries: 1,
  // 测试产物（截图/trace 等）统一进 output/，避免根目录散落
  outputDir: 'output/test-results',
  // 输出 JSON 供 scripts/badge.mjs 生成 e2e 徽章（真实通过数）
  reporter: [['list'], ['json', { outputFile: 'output/e2e-results.json' }]],
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 60000,
  },
})

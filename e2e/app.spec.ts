import { test, expect } from '@playwright/test'

// E2E 模式：跳过 Cesium Viewer 创建（CI headless 软件渲染慢，UI 交互测试不需要球）
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __E2E__?: boolean }).__E2E__ = true
  })
})

// 冒烟：页面加载 → 搜索 → 添加图层 → 删除图层（mock ArcGIS 请求，保证确定性）
test('冒烟：加载、搜索、添加、删除图层', async ({ page }) => {
  // 拦截 ArcGIS 搜索与 webmap 数据请求（避免依赖真实网络）
  await page.route('**/sharing/rest/search*', (route) =>
    route.fulfill({
      json: {
        results: [{ id: 'wm1', title: 'Test Imagery', thumbnail: null, numViews: 1, type: 'Web Map' }],
        nextStart: null,
        total: 1,
      },
    })
  )
  await page.route('**/sharing/rest/content/items/*?f=json', (route) =>
    route.fulfill({ json: { contentStatus: 'public_authoritative', groupDesignations: ['livingatlas'] } })
  )
  await page.route('**/sharing/rest/content/items/*/data*', (route) =>
    route.fulfill({
      json: {
        baseMap: {
          baseMapLayers: [
            { title: 'Imagery', url: 'https://x/World_Imagery/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
          ],
        },
        operationalLayers: [],
      },
    })
  )

  await page.goto('/')
  await expect(page).toHaveTitle('Earth Viewer')
  // 画廊加载出可渲染卡片
  await page.waitForSelector('.gallery-card', { timeout: 60000 })
  // 搜索
  await page.fill('.search input', 'Imagery')
  await page.waitForSelector('.gallery-card', { timeout: 60000 })
  // 添加第一张卡片
  await page.locator('.gallery-card .gc-add').first().click()
  await page.waitForSelector('.added-card', { timeout: 60000 })
  await expect(page.locator('.added-card')).toHaveCount(1)
  // 删除
  const removeBtn = page.locator('.added-card .remove-btn').first()
  await expect(removeBtn).toBeVisible({ timeout: 30000 })
  await removeBtn.click()
  await expect(page.locator('.added-card')).toHaveCount(0)
})

test('WebScene：搜索结果可添加到同一个地球图层列表', async ({ page }) => {
  await page.route('**/sharing/rest/search*', async (route) => {
    const url = new URL(route.request().url())
    const q = url.searchParams.get('q') ?? ''
    await route.fulfill({
      json: q.includes('Web Scene')
        ? {
            results: [{ id: 'scene-1', title: 'Mock WebScene', thumbnail: null, numViews: 10, type: 'Web Scene' }],
            nextStart: null,
            total: 1,
          }
        : { results: [], nextStart: null, total: 0 },
    })
  })
  await page.route('**/sharing/rest/content/items/*?f=json', (route) =>
    route.fulfill({ json: { contentStatus: 'public_authoritative', groupDesignations: ['livingatlas'] } })
  )
  await page.route('**/sharing/rest/content/items/scene-1/data*', (route) =>
    route.fulfill({
      json: {
        operationalLayers: [],
        baseMap: {
          baseMapLayers: [
            {
              title: 'Buildings',
              url: 'https://x/SceneServer/layers/0',
              layerType: 'ArcGISSceneServiceLayer',
            },
          ],
        },
        viewingMode: 'global',
      },
    })
  )

  await page.goto('/')
  await page.waitForSelector('.gallery-card', { timeout: 60000 })
  await expect(page.locator('.gallery-card')).toContainText('Mock WebScene')
  await page.locator('.gallery-card .gc-add').click()
  await expect(page.locator('.added-card')).toContainText('Mock WebScene')
})

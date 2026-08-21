import { test, expect } from '@playwright/test'

// 冒烟：页面加载 → 搜索 → 添加图层 → 删除图层（mock ArcGIS 请求，保证确定性）
test('冒烟：加载、搜索、添加、删除图层', async ({ page }) => {
  // 拦截 ArcGIS 搜索与 webmap 数据请求（避免依赖真实网络）
  await page.route('**/sharing/rest/search*', (route) =>
    route.fulfill({
      json: {
        results: [{ id: 'wm1', title: 'Test Imagery', thumbnail: null, numViews: 1 }],
        nextStart: null,
        total: 1,
      },
    })
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
  await page.waitForSelector('.gallery-card', { timeout: 15000 })
  // 搜索
  await page.fill('.search input', 'Imagery')
  await page.waitForSelector('.gallery-card', { timeout: 15000 })
  // 添加第一张卡片
  await page.locator('.gallery-card').first().click()
  await page.waitForSelector('.added-card', { timeout: 15000 })
  await expect(page.locator('.added-card')).toHaveCount(1)
  // 删除
  const removeBtn = page.locator('.added-card .remove-btn').first()
  await expect(removeBtn).toBeVisible({ timeout: 10000 })
  await removeBtn.click()
  await expect(page.locator('.added-card')).toHaveCount(0)
})

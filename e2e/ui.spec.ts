import { test, expect, type Page } from '@playwright/test'

// E2E 模式：跳过 Cesium Viewer 创建（CI headless 软件渲染慢，UI 交互测试不需要球）
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __E2E__?: boolean }).__E2E__ = true
  })
})

// 通用 mock：ArcGIS 搜索 + webmap 数据（保证交互测试确定性）
async function mockArcGIS(page: Page, searchDelay = 0) {
  await page.route('**/sharing/rest/search*', async (route) => {
    if (searchDelay > 0) await new Promise((r) => setTimeout(r, searchDelay))
    await route.fulfill({
      json: {
        results: [
          { id: 'wm1', title: 'Test Imagery', thumbnail: null, numViews: 1, type: 'Web Map' },
          { id: 'wm2', title: 'Wildfire Incidents', thumbnail: null, numViews: 2, type: 'Web Map' },
        ],
        nextStart: null,
        total: 2,
      },
    })
  })
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
}

test.beforeEach(async ({ page }) => {
  await mockArcGIS(page)
  await page.goto('/')
  await page.waitForSelector('.gallery-card', { timeout: 30000 })
})

test('主题切换更新 favicon 并持久化到 localStorage', async ({ page }) => {
  const favicon = page.locator('link[rel="icon"][type="image/svg+xml"]')
  await expect(favicon).toHaveAttribute('href', /favicon-dark\.svg/)
  await page.click('button[title="切换主题"]')
  await expect(favicon).toHaveAttribute('href', /favicon-light\.svg/)
  // 刷新后主题恢复（持久化）
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.reload()
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bodyBg)
  // 清理：切回深色，避免影响其他测试
  await page.click('button[title="切换主题"]')
})

test('回正/复位按钮可点击', async ({ page }) => {
  await page.click('button[title="回正视角"]')
  await page.click('button[title="复位视角"]')
})

test('左右面板折叠与展开', async ({ page }) => {
  const toggle = (locator: ReturnType<Page['locator']>) => locator.evaluate((el) => (el as HTMLElement).click())
  // 左侧面板（canvas 可能遮挡折叠条，用 evaluate 直接触发）
  const leftFold = page.locator('.panel .fold').first()
  await toggle(leftFold)
  await expect(page.locator('.panel.collapsed').first()).toBeVisible()
  await toggle(leftFold)
  await expect(page.locator('.panel.collapsed').first()).toHaveCount(0)
  // 右侧效果面板
  const rightFold = page.locator('.panel-right .fold')
  await toggle(rightFold)
  await expect(page.locator('.panel-right.collapsed')).toBeVisible()
  await toggle(rightFold)
  await expect(page.locator('.panel-right.collapsed')).toHaveCount(0)
})

test('效果开关与滑杆', async ({ page }) => {
  // 自动环绕开关
  const autoRotate = page.locator('button[aria-label="自动环绕"]')
  await autoRotate.click()
  await expect(autoRotate).toHaveClass(/on/)
  // 地形透明 → 透明度滑杆出现
  const translucency = page.locator('button[aria-label="地形透明"]')
  await translucency.click()
  await expect(page.locator('.panel-right input[type="range"]').first()).toBeVisible()
})

test('添加图层与删除', async ({ page }) => {
  await page.locator('.gallery-card .gc-add').first().click()
  await page.waitForSelector('.added-card', { timeout: 30000 })
  await expect(page.locator('.added-card')).toHaveCount(1)
  await page.locator('.added-card .remove-btn').click()
  await expect(page.locator('.added-card')).toHaveCount(0)
})

test('窄屏布局：面板可折叠且页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 })
  await page.reload()
  await page.waitForSelector('.gallery-card', { timeout: 30000 })
  // 折叠左面板
  await page.locator('.panel .fold').first().evaluate((el) => (el as HTMLElement).click())
  await expect(page.locator('.panel.collapsed').first()).toBeVisible()
  // 折叠右面板
  await page.locator('.panel-right .fold').evaluate((el) => (el as HTMLElement).click())
  await expect(page.locator('.panel-right.collapsed')).toBeVisible()
  // 无横向溢出
  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1
  )
  expect(noOverflow).toBe(true)
})

test('取消进行中的搜索', async ({ page }) => {
  // 重新挂载带延迟的 mock
  await mockArcGIS(page, 2000)
  await page.fill('.search input', 'wildfire')
  // 取消按钮出现（loading 中），用 evaluate 触发避免元素 detached
  await expect(page.locator('.search-cancel')).toBeVisible({ timeout: 5000 })
  await page.locator('.search-cancel').evaluate((el) => (el as HTMLElement).click())
  await expect(page.locator('.search-cancel')).toHaveCount(0)
})

test('detail 链接：跳转 ArcGIS item 详情页', async ({ page }) => {
  const card = page.locator('.gallery-card', { hasText: 'Test Imagery' })
  const detail = card.locator('.gc-detail')
  await expect(detail).toHaveAttribute('href', 'https://www.arcgis.com/home/item.html?id=wm1')
  await expect(detail).toHaveAttribute('target', '_blank')
  await expect(detail).toHaveAttribute('rel', 'noreferrer')
  await expect(detail).toHaveAttribute('aria-label', '查看 Test Imagery 详情')
})

test('沉浸模式：隐藏面板，按钮与 Esc 均可退出', async ({ page }) => {
  await page.click('button[title="进入沉浸模式"]')
  await expect(page.locator('.app')).toHaveClass(/immersive/)
  await expect(page.locator('.app-header')).toBeHidden()
  await expect(page.locator('.panel').first()).toBeHidden()
  await expect(page.locator('button[title="退出沉浸模式"]')).toBeVisible()
  // 按钮退出
  await page.click('button[title="退出沉浸模式"]')
  await expect(page.locator('.app')).not.toHaveClass(/immersive/)
  // 再次进入，Esc 退出
  await page.click('button[title="进入沉浸模式"]')
  await expect(page.locator('.app')).toHaveClass(/immersive/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.app')).not.toHaveClass(/immersive/)
})

test('顶栏 GitHub 链接指向仓库', async ({ page }) => {
  const gh = page.locator('a[title="GitHub"]')
  await expect(gh).toHaveAttribute('href', 'https://github.com/gis2all/earth-viewer')
  await expect(gh).toHaveAttribute('target', '_blank')
  await expect(gh).toHaveAttribute('rel', 'noreferrer')
})

test('封面加载：spinner 显示到图片就绪后隐藏，无缩略图用默认封面', async ({ page }) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  // 延迟默认封面响应，确保能观察到加载态
  await page.route('**/covers/default.png', async (route) => {
    await new Promise((r) => setTimeout(r, 1000))
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.reload()
  await page.waitForSelector('.gallery-card', { timeout: 30000 })
  const card = page.locator('.gallery-card').first()
  await expect(card.locator('.gc-thumb')).toHaveAttribute('src', /covers\/default\.png/)
  await expect(card.locator('.thumb-spinner')).toBeVisible()
  await expect(card.locator('.thumb-spinner')).toHaveAttribute('hidden', '', { timeout: 15000 })
})

test('添加后 gc-add 变为 is-added 并使用主题紫色', async ({ page }) => {
  const add = page.locator('.gallery-card', { hasText: 'Test Imagery' }).locator('.gc-add')
  await add.click()
  await page.waitForSelector('.added-card', { timeout: 30000 })
  await expect(add).toHaveClass(/is-added/)
  await expect(add).toBeDisabled()
  await expect(add).toHaveAttribute('aria-label', '已添加 Test Imagery')
  // 深色主题下 --added=#a59bf2
  await expect(add).toHaveCSS('color', 'rgb(165, 155, 242)')
})

test('浅色主题：detail 与已添加颜色随主题切换', async ({ page }) => {
  const card = page.locator('.gallery-card', { hasText: 'Test Imagery' })
  const detail = card.locator('.gc-detail')
  // 深色 --accent=#6e79d6
  await expect(detail).toHaveCSS('color', 'rgb(110, 121, 214)')
  await page.click('button[title="切换主题"]')
  // 浅色 --accent=#4e59c8
  await expect(detail).toHaveCSS('color', 'rgb(78, 89, 200)')
  const add = card.locator('.gc-add')
  await add.click()
  await page.waitForSelector('.added-card', { timeout: 30000 })
  // 浅色 --added=#6557c7
  await expect(add).toHaveCSS('color', 'rgb(101, 87, 199)')
  await page.click('button[title="切换主题"]')
})

test('面板宽度随视口按 clamp 比例缩放', async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 900 })
  await page.reload()
  await page.waitForSelector('.gallery-card', { timeout: 30000 })
  // 左面板 clamp(320px,20vw,423px)：2000*20%=400
  const leftW = await page.locator('.panel').first().evaluate((el) => el.getBoundingClientRect().width)
  // 右面板 clamp(240px,14vw,304px)：2000*14%=280
  const rightW = await page.locator('.panel-right').evaluate((el) => el.getBoundingClientRect().width)
  expect(leftW).toBeCloseTo(400, 0)
  expect(rightW).toBeCloseTo(280, 0)
})

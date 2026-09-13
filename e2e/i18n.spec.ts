import { test, expect, type Page } from '@playwright/test'

async function openWithMockData(page: Page) {
  await page.addInitScript(() => {
    ;(window as unknown as { __E2E__?: boolean }).__E2E__ = true
  })
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
  await page.waitForSelector('.gallery-card', { timeout: 30000 })
}

test.describe('Chinese browser locale', () => {
  test.use({ locale: 'zh-CN' })

  test.beforeEach(async ({ page }) => {
    await openWithMockData(page)
  })

  test('defaults to Chinese and persists a switch to English', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    const languageButton = page.getByTestId('language-toggle')
    await expect(languageButton).toHaveAttribute('title', '切换为英文')
    await expect(languageButton).toHaveText('中')

    await languageButton.click()

    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(languageButton).toHaveAttribute('title', 'Switch to Chinese')
    await expect(languageButton).toHaveText('EN')
    await expect(page.getByText('Layers', { exact: true })).toBeVisible()
    await expect(page.getByText('Effects', { exact: true })).toBeVisible()

    await page.reload()
    await page.waitForSelector('.gallery-card', { timeout: 30000 })
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByText('Layers', { exact: true })).toBeVisible()
  })
})

test.describe('English browser locale', () => {
  test.use({ locale: 'en-US' })

  test.beforeEach(async ({ page }) => {
    await openWithMockData(page)
  })

  test('defaults to English and switches to Chinese', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const languageButton = page.getByTestId('language-toggle')
    await expect(languageButton).toHaveAttribute('title', 'Switch to Chinese')
    await expect(languageButton).toHaveText('EN')

    await languageButton.click()

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(languageButton).toHaveAttribute('title', '切换为英文')
    await expect(languageButton).toHaveText('中')
    await expect(page.getByText('图层', { exact: true })).toBeVisible()
    await expect(page.getByText('效果', { exact: true })).toBeVisible()
  })
})

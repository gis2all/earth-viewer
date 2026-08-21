import { test, expect } from '@playwright/test'

// 真实 ArcGIS 集成测试（真实网络，验证公开服务的元数据/瓦片/查询可用）
// 注意：依赖网络与 ArcGIS 服务可用性，偶发失败属正常，重试 2 次
test.describe('真实 ArcGIS 服务集成', () => {
  test('World Imagery：metadata 有瓦片缓存（tiled），瓦片可访问', async ({ request }) => {
    const meta = await request.get(
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json',
      { timeout: 20000 }
    )
    expect(meta.ok()).toBeTruthy()
    const j = await meta.json()
    expect(j.tileInfo).toBeDefined()
    expect(j.spatialReference?.wkid).toBe(102100)
    const tile = await request.get(
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/0/0/0',
      { timeout: 20000 }
    )
    expect(tile.ok()).toBeTruthy()
  })

  test('FeatureServer query 返回要素', async ({ request }) => {
    const r = await request.get(
      'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/USA_Wildfires_v1/FeatureServer/0/query?where=1%3D1&f=geojson&resultRecordCount=5',
      { timeout: 25000 }
    )
    expect(r.ok()).toBeTruthy()
    const gj = await r.json()
    expect(Array.isArray(gj.features)).toBe(true)
    expect(gj.features.length).toBeGreaterThan(0)
  })

  test('搜索接口可用并返回结果', async ({ request }) => {
    const q = encodeURIComponent('type:"Web Map" AND access:public')
    const r = await request.get(
      'https://www.arcgis.com/sharing/rest/search?q=' + q + '&f=json&num=1',
      { timeout: 20000 }
    )
    expect(r.ok()).toBeTruthy()
    const j = await r.json()
    expect(j.total).toBeGreaterThan(0)
  })

  test('动态服务探测：无 tileInfo 的服务应能被识别（tiled=false）', async ({ request }) => {
    // 一个已知无缓存瓦片的动态 MapServer（Sampleserver6 动态服务）
    const meta = await request.get(
      'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer?f=json',
      { timeout: 20000 }
    )
    expect(meta.ok()).toBeTruthy()
    const j = await meta.json()
    expect(j.tileInfo).toBeUndefined()
    expect(j.capabilities ?? '').toContain('Map')
  })
})

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
    for (const type of ['Web Map', 'Web Scene']) {
      const q = encodeURIComponent(`type:"${type}" AND access:public`)
      const r = await request.get(
        'https://www.arcgis.com/sharing/rest/search?q=' + q + '&f=json&num=1',
        { timeout: 20000 }
      )
      expect(r.ok()).toBeTruthy()
      const j = await r.json()
      expect(j.total).toBeGreaterThan(0)
      expect(j.results?.[0]?.type).toBe(type)
    }
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

  test('Web Scene Topographic：数据包含 SceneServer 图层，可读取 I3S 元数据', async ({ request }) => {
    const item = await request.get(
      'https://www.arcgis.com/sharing/rest/content/items/7f6ae34b6cf749cd86de9df23421d701/data?f=json',
      { timeout: 25000 }
    )
    expect(item.ok()).toBeTruthy()
    const webScene = await item.json()
    const sceneLayer = webScene.baseMap?.baseMapLayers?.find(
      (layer: { layerType?: string }) => layer.layerType === 'ArcGISSceneServiceLayer'
    )
    expect(sceneLayer?.url).toContain('/SceneServer/')
    const scene = await request.get(sceneLayer.url + '?f=json', { timeout: 25000 })
    expect(scene.ok()).toBeTruthy()
    const sceneJson = await scene.json()
    expect(sceneJson.layers ?? sceneJson.store).toBeDefined()
  })

  test('Web Scene Topographic：VectorTile style source 的 PBF 瓦片可访问', async ({ request }) => {
    const style = await request.get(
      'https://cdn.arcgis.com/sharing/rest/content/items/d309c87e9f8c46a0af638d0533193e9b/resources/styles/root.json',
      { timeout: 25000 }
    )
    expect(style.ok()).toBeTruthy()
    const styleJson = await style.json()
    const source = Object.values(styleJson.sources ?? {}).find(
      (value: { url?: string; tiles?: string[] }) => value.url || value.tiles?.length
    ) as { url?: string; tiles?: string[] } | undefined
    const vectorTileServer = source?.url
    expect(vectorTileServer).toContain('/VectorTileServer')
    const tile = await request.get(vectorTileServer + '/tile/1/0/0.pbf', { timeout: 25000 })
    expect(tile.ok()).toBeTruthy()
  })
})



test.describe('real data per type', () => {
  const T = 20000
  test('Web Map container data readable', async ({ request }) => {
    const r = await request.get('https://www.arcgis.com/sharing/rest/content/items/86de95d4e0244cba80f0fa2c9403a7b2/data?f=json', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const wm = await r.json()
    expect(Array.isArray(wm.baseMap?.baseMapLayers)).toBe(true)
  })

  test('Web Scene container data readable', async ({ request }) => {
    const r = await request.get('https://www.arcgis.com/sharing/rest/content/items/7f6ae34b6cf749cd86de9df23421d701/data?f=json', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const ws = await r.json()
    expect(ws.baseMap?.baseMapLayers?.length ?? 0).toBeGreaterThan(0)
  })

  test('Map Service metadata readable', async ({ request }) => {
    const r = await request.get('https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer?f=json', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const j = await r.json()
    expect(j.spatialReference?.wkid).toBeDefined()
  })

  test('Feature Service query returns features', async ({ request }) => {
    const r = await request.get('https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/USA_Wildfires_v1/FeatureServer/0/query?where=1%3D1&f=geojson&resultRecordCount=3', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const gj = await r.json()
    expect(gj.features?.length ?? 0).toBeGreaterThan(0)
  })

  test('Image Service metadata readable', async ({ request }) => {
    const r = await request.get('https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer?f=json', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const j = await r.json()
    expect(j.capabilities || j.serviceDataType).toBeDefined()
  })

  test('Scene Service I3S metadata readable', async ({ request }) => {
    const r = await request.get('https://basemaps3d.arcgis.com/arcgis/rest/services/OpenStreetMap3D_Buildings_v1/SceneServer?f=json', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const j = await r.json()
    expect(Array.isArray(j.layers) || j.store).toBeTruthy()
  })

  test('KML file readable as XML', async ({ request }) => {
    const r = await request.get('https://atak.s3.us-west-1.amazonaws.com/FIRIS_inputs.kml', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const text = await r.text()
    expect(text).toMatch(/<kml/i)
  })

  test('WMS capabilities resolves layer name', async ({ request }) => {
    const r = await request.get('https://img.nj.gov/imagerywms/BlackWhite1930?service=WMS&request=GetCapabilities', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const xml = await r.text()
    expect(xml).toMatch(/<Name>BlackWhite1930<\/Name>/i)
  })

  test('WMTS GetTile template parses layer/scale', async ({ request }) => {
    const url = 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=grijs&STYLE=default&FORMAT=image/png&TILEMATRIXSET=EPSG:28992&TILEMATRIX={level}&TILEROW={row}&TILECOL={col}'
    const u = new URL(url)
    expect(u.searchParams.get('LAYER')).toBe('grijs')
    expect(u.searchParams.get('TILEMATRIXSET')).toBe('EPSG:28992')
  })

  test('WFS GetCapabilities resolves feature type', async ({ request }) => {
    const cap = 'https://zms.zonehaven.com/geoserver/z/wfs?authkey=IsNUsotPDBcZXvfWXTkKCo4erzkstHRA3Fw8aeXyVAtqKFLUuBPj4kGTr5FT3nkoJ1xi2xiuFogCAy8OZcMkhy1AmxyelvL5RB4NJxjGgzMbRM2VmsU28SxccRmvOt6Y&service=WFS&request=GetCapabilities&version=2.0.0'
    const r = await request.get(cap, { timeout: T })
    expect(r.ok()).toBeTruthy()
    const xml = await r.text()
    expect(xml).toMatch(/<[A-Za-z]*:?Name>z:evacuation_zone_status_CA<\/[A-Za-z]*:?Name>/i)
  })

  test('Vector Tile Service style sources parse', async ({ request }) => {
    const r = await request.get('https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/styles/root.json', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const st = await r.json()
    expect(Object.keys(st.sources ?? {}).length).toBeGreaterThan(0)
  })

  test('GeoJson file data readable', async ({ request }) => {
    const r = await request.get('https://www.arcgis.com/sharing/rest/content/items/72f29738d58345bab64cbf92a6425995/data', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const j = await r.json()
    expect(j.type).toBe('FeatureCollection')
  })

  test('CSV file data readable', async ({ request }) => {
    const r = await request.get('https://www.arcgis.com/sharing/rest/content/items/153a138859bb4c418156642b5b74925b/data', { timeout: T })
    expect(r.ok()).toBeTruthy()
    const text = await r.text()
    expect(text.length).toBeGreaterThan(10)
  })
})

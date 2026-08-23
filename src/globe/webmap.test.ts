import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isFeatureLayer,
  isGeoJsonLayer,
  isKmlLayer,
  fetchFeatureStyle,
  fetchFeatureGeoJSON,
  fetchWebmap,
  detectMapService,
  providerForWebLayer,
} from './webmap'

// Cesium 在 node 环境不可用，mock 掉（webmap 只用到 Color / WMS provider / UrlTemplate）
vi.mock('cesium', () => ({
  Color: { fromBytes: (...args: number[]) => args },
  WebMapServiceImageryProvider: vi.fn(),
  WebMapTileServiceImageryProvider: vi.fn(),
  UrlTemplateImageryProvider: vi.fn(),
  GeographicTilingScheme: vi.fn(),
  WebMercatorTilingScheme: vi.fn(),
}))

describe('图层类型判断', () => {
  it('isFeatureLayer', () => {
    expect(isFeatureLayer({ layerType: 'ArcGISFeatureLayer', url: 'x' })).toBe(true)
    expect(isFeatureLayer({ layerType: 'GeoJSONLayer', url: 'x' })).toBe(false)
  })
  it('isGeoJsonLayer / isKmlLayer', () => {
    expect(isGeoJsonLayer({ layerType: 'GeoJSONLayer' })).toBe(true)
    expect(isKmlLayer({ layerType: 'KMLLayer' })).toBe(true)
    expect(isKmlLayer({ type: 'KML Collection' })).toBe(true)
  })
})

describe('fetchWebmap', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('成功拉取 webmap JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ title: 'wm' }) })))
    const wm = await fetchWebmap('abc')
    expect(wm).toEqual({ title: 'wm' })
  })

  it('HTTP 失败抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(fetchWebmap('abc')).rejects.toThrow()
  })
})

// 注意：detectMapService 有模块级 CRS_CACHE（按 URL 缓存），测试必须用唯一 URL 前缀（d1/d2/d3...），
// 否则后一个用例会命中前一个的缓存，结果与预期不符。新增用例请换新前缀。
describe('detectMapService（tiled / dynamic / 失败）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('有 tileInfo → tiled=true，读取 wkid 与最大级别', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ spatialReference: { wkid: 4326 }, tileInfo: { lods: [{}, {}, {}] } }),
      }))
    )
    const info = await detectMapService('https://d1/MapServer/')
    expect(info).toEqual({ wkid: 4326, maxLevel: 2, tiled: true })
  })

  it('无 tileInfo → tiled=false（动态服务）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 } }) })))
    expect(await detectMapService('https://d2/MapServer')).toMatchObject({ tiled: false })
  })

  it('metadata 非 ok → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await detectMapService('https://d3/MapServer')).toBeNull()
  })

  it('无 spatialReference.wkid → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    expect(await detectMapService('https://d4/MapServer')).toBeNull()
  })
})

describe('providerForWebLayer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('MapServer 4326 → UrlTemplate + GeographicTilingScheme', async () => {
    const { UrlTemplateImageryProvider, GeographicTilingScheme } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    const geo = GeographicTilingScheme as unknown as ReturnType<typeof vi.fn>
    ut.mockClear(); geo.mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ spatialReference: { wkid: 4326 }, tileInfo: { lods: [{}, {}, {}] } }),
      }))
    )
    await providerForWebLayer({ url: 'https://p4326/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })
    expect(ut).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://p4326/MapServer/tile/{z}/{y}/{x}', maximumLevel: 2 })
    )
    expect(geo).toHaveBeenCalled()
  })

  it('MapServer 3857 tiled → UrlTemplate（默认 tilingScheme，无 maximumLevel）', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) })))
    await providerForWebLayer({ url: 'https://p3857/MapServer', layerType: 'ArcGISMapServiceLayer' })
    expect(ut).toHaveBeenCalledWith({ url: 'https://p3857/MapServer/tile/{z}/{y}/{x}' })
  })

  it('动态 MapServer（无 tileInfo）→ 走 /export 出图，并使用 4326 Geographic 网格', async () => {
    const { UrlTemplateImageryProvider, GeographicTilingScheme } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    const geo = GeographicTilingScheme as unknown as ReturnType<typeof vi.fn>
    ut.mockClear(); geo.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 } }) })))
    const pr = await providerForWebLayer({ url: 'https://pdyn/MapServer', layerType: 'ArcGISMapServiceLayer' })
    expect(pr).not.toBeNull()
    expect(ut).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('/export?bbox={westDegrees}') }))
    expect(geo).toHaveBeenCalled()
  })

  it('动态 MapServer 4326 → 用 GeographicTilingScheme', async () => {
    const { GeographicTilingScheme } = await import('cesium')
    const geo = GeographicTilingScheme as unknown as ReturnType<typeof vi.fn>
    geo.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 4326 } }) })))
    await providerForWebLayer({ url: 'https://pdyn4326/ImageServer', layerType: 'ArcGISImageServiceLayer' })
    expect(geo).toHaveBeenCalled()
  })

  it('WMTS 带图层名 → WebMapTileServiceImageryProvider；缺层名 → null', async () => {
    const { WebMapTileServiceImageryProvider } = await import('cesium')
    const wmts = WebMapTileServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    wmts.mockClear()
    await providerForWebLayer({ url: 'https://x/WMTS', layerType: 'WMTSLayer', layers: [{ name: 'layerA' }] })
    expect(wmts).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x/WMTS', layer: 'layerA' }))
    expect(await providerForWebLayer({ url: 'https://x/WMTS', layerType: 'WMTSLayer' })).toBeNull()
  })

  it('WMTS 使用 WebMap 配置中的 style/format/tileMatrixSetID', async () => {
    const { WebMapTileServiceImageryProvider } = await import('cesium')
    const wmts = WebMapTileServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    wmts.mockClear()
    await providerForWebLayer({
      url: 'https://x/WMTS',
      layerType: 'WMTSLayer',
      layerName: 'roads',
      style: 'night',
      format: 'image/jpeg',
      tileMatrixSetID: 'GoogleMapsCompatible',
    } as never)
    expect(wmts).toHaveBeenCalledWith(expect.objectContaining({
      layer: 'roads',
      style: 'night',
      format: 'image/jpeg',
      tileMatrixSetID: 'GoogleMapsCompatible',
    }))
  })

  it('WebTiledLayer → UrlTemplate 用其 urlTemplate', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    await providerForWebLayer({ url: 'https://x/wm', layerType: 'WebTiledLayer', urlTemplate: 'https://t/{z}/{y}/{x}.png' })
    expect(ut).toHaveBeenCalledWith({ url: 'https://t/{z}/{y}/{x}.png' })
  })

  it('layerType 含 MapServer 且带 url → provider', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) })))
    await providerForWebLayer({ url: 'https://ptype/MapServer', layerType: 'ArcGISMapServiceLayer' })
    expect(ut).toHaveBeenCalled()
  })

  it('WMS：layerName 优先；无则 layers 字符串', async () => {
    const { WebMapServiceImageryProvider } = await import('cesium')
    const wms = WebMapServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    wms.mockClear()
    await providerForWebLayer({ url: 'https://x/wms', type: 'WMS', layerName: 'named' })
    expect(wms).toHaveBeenCalledWith(expect.objectContaining({ layers: 'named' }))
    wms.mockClear()
    await providerForWebLayer({ url: 'https://x/wms', type: 'WMSLayer', layers: 'single' })
    expect(wms).toHaveBeenCalledWith(expect.objectContaining({ layers: 'single' }))
  })

  it('OpenStreetMap / urlTemplate / 未知 → 分支', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    await providerForWebLayer({ url: 'https://x/osm', layerType: 'OpenStreetMap' })
    expect(ut).toHaveBeenCalled()
    ut.mockClear()
    await providerForWebLayer({ url: 'https://x/t', urlTemplate: 'https://x/{z}/{x}/{y}' })
    expect(ut).toHaveBeenCalledWith({ url: 'https://x/{z}/{x}/{y}' })
    expect(await providerForWebLayer({ url: 'https://x/unknown', layerType: 'Foo' })).toBeNull()
  })
})

describe('fetchFeatureStyle（SimpleRenderer 符号映射）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('点符号 → marker 样式', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSMS', color: [255, 0, 0, 255], size: 8 } } } }),
    })))
    const style = await fetchFeatureStyle('https://x/FeatureServer/0')
    expect(style?.markerSize).toBe(8)
  })

  it('线符号 → stroke', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSLS', color: [0, 0, 255, 255], width: 2 } } } }),
    })))
    const style = await fetchFeatureStyle('https://x/FeatureServer/0')
    expect(style?.strokeWidth).toBe(2)
  })

  it('面符号 → fill + outline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSFS', color: [0, 128, 255, 200], outline: { color: [0, 0, 0, 255], width: 1 } } } } }),
    })))
    const style = await fetchFeatureStyle('https://x/FeatureServer/0')
    expect(style?.fill).toBeDefined()
    expect(style?.strokeWidth).toBe(1)
  })

  it('未知符号 / 非 simple / 失败 / 无 symbol → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriPTS' } } } }),
    })))
    expect(await fetchFeatureStyle('https://x/FeatureServer/0')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ drawingInfo: { renderer: { type: 'uniqueValue' } } }) })))
    expect(await fetchFeatureStyle('https://x/FeatureServer/0')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await fetchFeatureStyle('https://x/FeatureServer/0')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    expect(await fetchFeatureStyle('https://x/FeatureServer/0')).toBeNull()
  })
})

describe('fetchFeatureGeoJSON 分页', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('meta 探测失败 → 用默认页大小 2000 拉取', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).endsWith('?f=json')) return { ok: false }
      const m = /resultOffset=(\d+)/.exec(String(u))
      const n = m ? Number(m[1]) : 0
      return { ok: true, json: async () => ({ features: n >= 4000 ? [] : Array.from({ length: 2000 }, (_, i) => ({ id: n + i })) }) }
    }))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0', 4000)) as { features: unknown[] }
    expect(gj.features).toHaveLength(4000)
  })

  it('空页（无要素）→ 立即停止', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0')) as { features: unknown[] }
    expect(gj.features).toHaveLength(0)
  })

  it('查询失败抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).endsWith('?f=json')) return { ok: true, json: async () => ({ maxRecordCount: 100 }) }
      return { ok: false }
    }))
    await expect(fetchFeatureGeoJSON('https://x/FeatureServer/0')).rejects.toThrow('要素服务查询失败')
  })

  it('???????? id?? 0??? /id/query ??', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(String(u))
      if (String(u).endsWith('?f=json')) return { ok: true, json: async () => ({ layers: [{ id: 1, name: 'PRE_TP' }], maxRecordCount: 100 }) }
      return { ok: true, json: async () => ({ features: [{ id: 1 }] }) }
    }))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer')) as { features: unknown[] }
    expect(gj.features).toHaveLength(1)
    expect(urls.some((u) => u.includes('/1/query'))).toBe(true)
  })

  it('????? geojson ??? f=json ?? GeoJSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u)
      if (url.endsWith('?f=json')) return { ok: true, json: async () => ({ layers: [{ id: 0 }] }) }
      if (url.includes('f=geojson')) return { ok: false }
      return { ok: true, json: async () => ({ features: [{ attributes: { name: 'a' }, geometry: { x: 10, y: 20 } }] }) }
    }))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0')) as { features: Array<{ geometry: { type: string; coordinates: number[] } }> }
    expect(gj.features[0].geometry.type).toBe('Point')
    expect(gj.features[0].geometry.coordinates).toEqual([10, 20])
  })

  it('arcgis JSON ?/??????? LineString/Polygon', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u)
      if (url.endsWith('?f=json')) return { ok: true, json: async () => ({ layers: [{ id: 0 }] }) }
      if (url.includes('f=geojson')) return { ok: false }
      return { ok: true, json: async () => ({ features: [
        { attributes: {}, geometry: { paths: [[[0, 0], [1, 1]]] } },
        { attributes: {}, geometry: { rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      ] }) }
    }))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0')) as { features: Array<{ geometry: { type: string } }> }
    expect(gj.features[0].geometry.type).toBe('LineString')
    expect(gj.features[1].geometry.type).toBe('Polygon')
  })


})

describe('WMS provider 构造（原有）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('图层名从 layers 数组首项提取', async () => {
    const { WebMapServiceImageryProvider } = await import('cesium')
    const wmsCtor = WebMapServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    await providerForWebLayer({ url: 'https://x/wms', type: 'WMS', layers: [{ name: 'layerA', title: 'A' }] })
    expect(wmsCtor).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x/wms', layers: 'layerA' }))
  })

  it('按 resultOffset 分页拉取直到拉完或达上限', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(String(u))
      if (String(u).endsWith('?f=json')) return { ok: true, json: async () => ({ maxRecordCount: 1000 }) }
      const m = /resultOffset=(\d+)/.exec(String(u))
      const n = m ? Number(m[1]) : 0
      const features = n >= 3000 ? [] : Array.from({ length: 1000 }, (_, i) => ({ id: n + i }))
      return { ok: true, json: async () => ({ features }) }
    }))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0', 3000)) as { features: { id: number }[] }
    expect(gj.features.length).toBe(3000)
    expect(urls.some((u) => u.includes('resultOffset=2000'))).toBe(true)
    expect(urls.some((u) => u.includes('outSR=4326'))).toBe(true)
  })

  it('服务不支持分页（返回数量不变）时停止', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (String(u).endsWith('?f=json')) return { ok: true, json: async () => ({ maxRecordCount: 1000 }) }
      return { ok: true, json: async () => ({ features: [{ id: 1 }] }) }
    }))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0')) as { features: unknown[] }
    expect(gj.features.length).toBe(1)
  })

  it('服务忽略 resultOffset 返回相同满页时停止（重复检测）', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      calls++
      if (String(u).endsWith('?f=json')) return { ok: true, json: async () => ({ maxRecordCount: 1000 }) }
      return { ok: true, json: async () => ({ features: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: 'same' })) }) }
    }))
    const gj = (await fetchFeatureGeoJSON('https://x/FeatureServer/0', 5000)) as { features: unknown[] }
    expect(gj.features.length).toBe(1000)
    expect(calls).toBeLessThan(5)
  })

  it('无图层名 → 返回 null', async () => {
    const { WebMapServiceImageryProvider } = await import('cesium')
    const wmsCtor = WebMapServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    wmsCtor.mockClear()
    const p = await providerForWebLayer({ url: 'https://x/wms', type: 'WMS' })
    expect(p).toBeNull()
    expect(wmsCtor).not.toHaveBeenCalled()
  })
})

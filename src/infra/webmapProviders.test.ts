import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchFeatureStyle,
  providerForWebLayer,
} from './webmapProviders'
import { classifyWebLayerKind, layerKindOf } from '../domain/webLayerKind'
import { riskOfLayer } from '../domain/loadSafety'
import { classifyLayer } from '../domain/layerAssessment'
import type { WebLayer } from '../domain/types'

// Cesium 在 node 环境不可用，mock 掉（webmap 只用到 Color / WMS provider / UrlTemplate）
vi.mock('cesium', () => ({
  Color: { fromBytes: (...args: number[]) => args },
  WebMapServiceImageryProvider: vi.fn(),
  WebMapTileServiceImageryProvider: vi.fn(),
  UrlTemplateImageryProvider: vi.fn(),
  GeographicTilingScheme: vi.fn(),
  WebMercatorTilingScheme: vi.fn(),
}))

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

  it('动态 ImageServer（无 tileInfo）→ 走 /exportImage 出图，而非固定 /export', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 102100, latestWkid: 3857 } }) })))
    await providerForWebLayer({ url: 'https://pimg/ImageServer', layerType: 'ArcGISImageServiceLayer' })
    expect(ut).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('/exportImage?bbox={westDegrees}') }))
  })

  it('动态 MapServer 用 /export，ImageServer 用 /exportImage，端点不混用', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 } }) })))
    await providerForWebLayer({ url: 'https://m/MapServer', layerType: 'ArcGISMapServiceLayer' })
    const mapUrl = (ut.mock.calls[0][0] as { url: string }).url
    ut.mockClear()
    await providerForWebLayer({ url: 'https://i/ImageServer', layerType: 'ArcGISImageServiceLayer' })
    const imgUrl = (ut.mock.calls[0][0] as { url: string }).url
    expect(mapUrl).toContain('/export?bbox={westDegrees}')
    expect(imgUrl).toContain('/exportImage?bbox={westDegrees}')
  })

  it('自定义投影瓦片（RD 28992）→ 不走 /tile，改用 /export 重投影出图', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 28992 }, tileInfo: { lods: [{}, {}, {}] } }) })))
    await providerForWebLayer({ url: 'https://prd/MapServer', layerType: 'ArcGISMapServiceLayer' })
    expect(ut).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('/export?bbox={westDegrees}') }))
    expect(ut).not.toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('/tile/{z}/{y}/{x}') }))
  })

  it('Web Mercator 102100 瓦片 → 仍走 /tile，不因非 4326 被误判为自定义投影', async () => {
    const { UrlTemplateImageryProvider } = await import('cesium')
    const ut = UrlTemplateImageryProvider as unknown as ReturnType<typeof vi.fn>
    ut.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spatialReference: { wkid: 102100, latestWkid: 3857 }, tileInfo: { lods: [{}, {}, {}] } }) })))
    await providerForWebLayer({ url: 'https://pmerc/MapServer', layerType: 'ArcGISMapServiceLayer' })
    expect(ut).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://pmerc/MapServer/tile/{z}/{y}/{x}' }))
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
    expect(ut).toHaveBeenCalledWith({ url: 'https://t/{z}/{y}/{x}.png', maximumLevel: 16 })
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
    expect(ut).toHaveBeenCalledWith({ url: 'https://x/{z}/{x}/{y}', maximumLevel: 16 })
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

describe('图层分类跨模块一致性（W4.4 防再次漂移）', () => {
  it('评估、风险、Provider 对同一 WebLayer 不再各自维护正则', () => {
    const cases: Array<{
      op: WebLayer
      fine: string
      coarse: ReturnType<typeof layerKindOf>
      risk: ReturnType<typeof riskOfLayer>
      support: ReturnType<typeof classifyLayer>['support']
    }> = [
      {
        op: { layerType: 'ArcGISTiledMapServiceLayer', url: 'https://x/MapServer' },
        fine: 'map',
        coarse: 'map',
        risk: 'medium',
        support: 'full',
      },
      {
        op: { layerType: 'ArcGISFeatureLayer', url: 'https://x/FeatureServer/0' },
        fine: 'feature',
        coarse: 'feature',
        risk: 'heavy',
        support: 'partial',
      },
      {
        op: { layerType: 'OGCFeatureServer', url: 'https://x/FeatureServer' },
        fine: 'wfs',
        coarse: 'wfs',
        risk: 'heavy',
        support: 'partial',
      },
      {
        op: { urlTemplate: 'https://x/{z}/{x}/{y}.png' },
        fine: 'urlTemplate',
        coarse: null,
        risk: 'light',
        support: 'full',
      },
    ]

    for (const { op, fine, coarse, risk, support } of cases) {
      expect(classifyWebLayerKind(op)).toBe(fine)
      expect(layerKindOf(op)).toBe(coarse)
      expect(riskOfLayer(op)).toBe(risk)
      expect(classifyLayer(op, 'business').support).toBe(support)
    }
  })

  it('layerType 优先于 type，FeatureLayer 不被同 URL/type 的 MapServer 分支抢走', async () => {
    const conflict: WebLayer = { type: 'ArcGISTiledMapServiceLayer', layerType: 'ArcGISFeatureLayer', url: 'https://x/MapServer' }
    expect(classifyWebLayerKind(conflict)).toBe('feature')
    expect(layerKindOf(conflict)).toBe('feature')
    expect(riskOfLayer(conflict)).toBe('heavy')
    expect(classifyLayer(conflict, 'business').support).toBe('partial')
    await expect(providerForWebLayer(conflict)).resolves.toBeNull()
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

  it('无图层名 → 返回 null', async () => {
    const { WebMapServiceImageryProvider } = await import('cesium')
    const wmsCtor = WebMapServiceImageryProvider as unknown as ReturnType<typeof vi.fn>
    wmsCtor.mockClear()
    const p = await providerForWebLayer({ url: 'https://x/wms', type: 'WMS' })
    expect(p).toBeNull()
    expect(wmsCtor).not.toHaveBeenCalled()
  })
})

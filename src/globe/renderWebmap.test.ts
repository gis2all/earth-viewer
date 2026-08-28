import { describe, it, expect, vi, beforeEach } from 'vitest'
import '../test/mocks/cesium'
import type { CesiumFacade } from '../infra/CesiumFacade'
import type { LayerRenderJob } from '../domain/render'
import { createEmptyRuntime, type LayerRuntime } from '../domain/runtime'
import { SAFETY } from './loadSafety'
import type { FeatureServiceInfo } from './viewport/featureQuery'
import { renderWebmap } from './renderWebmap'

// ---- mock 数据获取/查询层（纯渲染分支用假数据驱动，避免真网络） ----
const webmapMock = vi.hoisted(() => ({
  fetchFeatureStyle: vi.fn(),
  fetchFeatureRenderer: vi.fn(),
}))
const fqMock = vi.hoisted(() => ({
  resolveFeatureService: vi.fn(),
  resolveFeatureQueryBase: vi.fn(),
}))
const queryMock = vi.hoisted(() => ({ queryViewportData: vi.fn() }))
const primMock = vi.hoisted(() => ({ hasPrimitiveRendering: vi.fn(() => false) }))
const ogcMock = vi.hoisted(() => ({ fetchOgcFeatureGeoJSON: vi.fn() }))
const csvMock = vi.hoisted(() => ({ fetchCsvGeoJSON: vi.fn() }))

vi.mock('./webmap', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./webmap')>()
  return {
    ...mod,
    fetchFeatureStyle: webmapMock.fetchFeatureStyle,
    fetchFeatureRenderer: webmapMock.fetchFeatureRenderer,
  }
})
vi.mock('./viewport/featureQuery', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./viewport/featureQuery')>()
  return {
    ...mod,
    resolveFeatureService: fqMock.resolveFeatureService,
    resolveFeatureQueryBase: fqMock.resolveFeatureQueryBase,
  }
})
vi.mock('./viewport/query', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./viewport/query')>()
  return { ...mod, queryViewportData: queryMock.queryViewportData }
})
vi.mock('./viewport/primitive', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./viewport/primitive')>()
  return { ...mod, hasPrimitiveRendering: primMock.hasPrimitiveRendering }
})
vi.mock('./ogc', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./ogc')>()
  return { ...mod, fetchOgcFeatureGeoJSON: ogcMock.fetchOgcFeatureGeoJSON }
})
vi.mock('./csv', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./csv')>()
  return { ...mod, fetchCsvGeoJSON: csvMock.fetchCsvGeoJSON }
})

function makeJob(webmap: Record<string, unknown>, overrides: Partial<LayerRenderJob> = {}): LayerRenderJob {
  return {
    id: 'l1',
    title: '测试图层',
    webmap,
    runtime: createEmptyRuntime(),
    signal: new AbortController().signal,
    keepAlive: vi.fn(() => true),
    hasFlew: vi.fn(() => false),
    markFlew: vi.fn(),
    isReferenceVisible: vi.fn(() => true),
    onNote: vi.fn(),
    onError: vi.fn(),
    onClearError: vi.fn(),
    attachViewport: vi.fn(),
    ...overrides,
  }
}

function makeFacade(overrides: Partial<Record<keyof CesiumFacade, unknown>> = {}) {
  const f = {
    addWebLayerImagery: vi.fn(async () => false),
    addVectorTile: vi.fn(),
    addGeoJson: vi.fn(async (data: unknown, runtime: LayerRuntime) => {
      const ds = { data, entities: { values: [] as unknown[] } }
      runtime.dataSources.push({ id: 'ds', dispose: () => {} })
      return ds
    }),
    addKmlNative: vi.fn(async () => ({ entities: { values: [] } })),
    addScene: vi.fn(async () => ({ prim: true })),
    add3dTiles: vi.fn(async () => ({ tileset: true })),
    createViewport: vi.fn(() => ({ controller: { dispose: vi.fn() }, unsubscribeMoveEnd: vi.fn() })),
    viewEnvelope: vi.fn(() => null),
    flyTo: vi.fn(),
    flyToExtent: vi.fn(),
    flyToHome: vi.fn(),
    ...overrides,
  }
  return f as unknown as CesiumFacade & Record<string, ReturnType<typeof vi.fn>>
}

function webmapWithLayer(layer: Record<string, unknown>): Record<string, unknown> {
  return { baseMap: { baseMapLayers: [] }, operationalLayers: [layer] }
}

const fc = (features: unknown[] = []): Record<string, unknown> => ({ type: 'FeatureCollection', features })

const makeFeatureService = (layers: string[], extent?: FeatureServiceInfo['extent']): FeatureServiceInfo => ({
  layers,
  ...(extent ? { extent } : {}),
})

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  webmapMock.fetchFeatureStyle.mockResolvedValue(null)
  webmapMock.fetchFeatureRenderer.mockResolvedValue(null)
  fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService([]))
  fqMock.resolveFeatureQueryBase.mockResolvedValue('https://x/FeatureServer/0')
  queryMock.queryViewportData.mockResolvedValue({ features: [], capped: false, vertices: 0 })
  ogcMock.fetchOgcFeatureGeoJSON.mockResolvedValue(fc())
  csvMock.fetchCsvGeoJSON.mockResolvedValue(fc())
  primMock.hasPrimitiveRendering.mockReturnValue(false)
})

describe('renderWebmap：分支渲染', () => {
  it('影像类图层 → addWebLayerImagery 成功且不落错误', async () => {
    const f = makeFacade({ addWebLayerImagery: vi.fn(async () => true) })
    const job = makeJob(
      webmapWithLayer({ id: 'op', title: 'Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' })
    )
    await renderWebmap(job, f)
    expect(f.addWebLayerImagery).toHaveBeenCalledTimes(1)
    expect(f.addWebLayerImagery.mock.calls[0][0]).toMatchObject({ id: 'op', layerType: 'ArcGISTiledMapServiceLayer' })
    expect(job.onError).not.toHaveBeenCalled()
  })

  it('矢量瓦片 → addVectorTile 挂载回调（成功清错/失败报错）', async () => {
    const f = makeFacade()
    const job = makeJob(
      webmapWithLayer({ id: 'vt', title: 'VT', url: 'https://x/VectorTileServer', styleUrl: 'https://x/style.json', layerType: 'ArcGISVectorTileLayer' })
    )
    await renderWebmap(job, f)
    expect(f.addVectorTile).toHaveBeenCalledTimes(1)
    const [op, signal, runtime, keepAlive, onError, onDone] = f.addVectorTile.mock.calls[0]
    expect(op).toMatchObject({ id: 'vt' })
    expect(signal).toBe(job.signal)
    expect(runtime).toBe(job.runtime)
    expect(keepAlive()).toBe(true)
    onError('矢量瓦片渲染失败：VT')
    expect(job.onError).toHaveBeenCalledWith('矢量瓦片渲染失败：VT')
    onDone()
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('内嵌 FeatureCollection → 预算管线 + addGeoJson + 清错', async () => {
    const f = makeFacade()
    const job = makeJob(
      webmapWithLayer({
        id: 'fc',
        title: '内嵌',
        layerType: 'FeatureCollection',
        layerDefinition: { featureCollection: { featureCollection: { features: [{ type: 'Feature' }] } } },
      })
    )
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect((f.addGeoJson.mock.calls[0][0] as { features: unknown[] }).features).toHaveLength(1)
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('内嵌 FeatureCollection 为空 → 直接报错', async () => {
    const f = makeFacade()
    const job = makeJob(webmapWithLayer({ id: 'fc2', layerType: 'FeatureCollection' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('内嵌要素集为空')
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('3D Scene → addScene；失败报错', async () => {
    const f = makeFacade()
    const job = makeJob(webmapWithLayer({ id: 'sc', title: 'Scene', url: 'https://x/SceneServer', layerType: 'ArcGISSceneLayer' }))
    await renderWebmap(job, f)
    expect(f.addScene).toHaveBeenCalledWith('https://x/SceneServer', job.runtime)
    expect(job.onClearError).toHaveBeenCalled()

    f.addScene.mockRejectedValueOnce(new Error('boom'))
    const job2 = makeJob(webmapWithLayer({ id: 'sc2', title: 'Scene2', url: 'https://x/SceneServer', layerType: 'ArcGISSceneLayer' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderWebmap(job2, f)
    expect(job2.onError).toHaveBeenCalledWith('3D 场景加载失败：Scene2')
  })

  it('OGC 3D Tiles → add3dTiles', async () => {
    const f = makeFacade()
    const job = makeJob(webmapWithLayer({ id: 't3d', title: 'Tiles', url: 'https://x/tileset.json', layerType: '3DTilesLayer' }))
    await renderWebmap(job, f)
    expect(f.add3dTiles).toHaveBeenCalledWith('https://x/tileset.json', job.runtime)
  })

  it('WFS → OGC 协议读取 + 预算 + addGeoJson + 清错', async () => {
    const f = makeFacade()
    ogcMock.fetchOgcFeatureGeoJSON.mockResolvedValue(fc([{ type: 'Feature' }]))
    const job = makeJob(webmapWithLayer({ id: 'wfs', title: 'WFS', url: 'https://x/FeatureServer', layerType: 'WFS' }))
    await renderWebmap(job, f)
    expect(ogcMock.fetchOgcFeatureGeoJSON).toHaveBeenCalledWith('https://x/FeatureServer', expect.anything(), job.signal)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('CSV → CSV 协议读取 + addGeoJson', async () => {
    const f = makeFacade()
    csvMock.fetchCsvGeoJSON.mockResolvedValue(fc([{ type: 'Feature' }]))
    const job = makeJob(webmapWithLayer({ id: 'csv', title: 'CSV', url: 'https://x/data.csv', layerType: 'CSVLayer' }))
    await renderWebmap(job, f)
    expect(csvMock.fetchCsvGeoJSON).toHaveBeenCalledWith('https://x/data.csv', expect.anything(), job.signal)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
  })

  it('Feature 单层 GeoJSON 路径：视口查询 + renderer 样式 + addGeoJson', async () => {
    const f = makeFacade()
    fqMock.resolveFeatureService.mockResolvedValue(
      makeFeatureService(['https://x/FeatureServer/0'], { west: 100, south: 10, east: 120, north: 30, wkid: 4326 })
    )
    webmapMock.fetchFeatureRenderer.mockResolvedValue({ type: 'simple', symbol: { type: 'esriSMS', color: [255, 0, 0, 255], size: 8 } })
    queryMock.queryViewportData.mockResolvedValue({ features: [{ type: 'Feature' }], capped: false, vertices: 1 })
    const job = makeJob(webmapWithLayer({ id: 'ft', title: 'Quakes', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    await renderWebmap(job, f)
    expect(fqMock.resolveFeatureService).toHaveBeenCalledWith('https://x/FeatureServer/0')
    expect(queryMock.queryViewportData).toHaveBeenCalledWith(
      'https://x/FeatureServer/0',
      { west: -180, south: -90, east: 180, north: 90 },
      { maxFeatures: SAFETY.MAX_RENDER_FEATURES, outFields: '*' },
      job.signal
    )
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect(f.addGeoJson.mock.calls[0][2]).toBeUndefined()
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('Feature 单层 Primitive 路径：createViewport + attachViewport，不再手动渲染', async () => {
    const f = makeFacade()
    primMock.hasPrimitiveRendering.mockReturnValue(true)
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/0']))
    const job = makeJob(webmapWithLayer({ id: 'ft', title: 'Quakes', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    await renderWebmap(job, f)
    expect(fqMock.resolveFeatureQueryBase).toHaveBeenCalledWith('https://x/FeatureServer/0')
    expect(f.createViewport).toHaveBeenCalledWith('https://x/FeatureServer/0', SAFETY.MAX_FEATURES)
    expect(job.attachViewport).toHaveBeenCalled()
    expect(f.addGeoJson).not.toHaveBeenCalled()
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('Feature 单层 Primitive 失败 → 回退空 GeoJSON（不抛错）', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    primMock.hasPrimitiveRendering.mockReturnValue(true)
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/0']))
    fqMock.resolveFeatureQueryBase.mockRejectedValue(new Error('no base'))
    const job = makeJob(webmapWithLayer({ id: 'ft', title: 'Q', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect((f.addGeoJson.mock.calls[0][0] as { features: unknown[] }).features).toEqual([])
  })

  it('Feature 多层：simple 参考层描边 + uniqueValue 事件层分色', async () => {
    const f = makeFacade()
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    webmapMock.fetchFeatureRenderer.mockImplementation((url: string) =>
      Promise.resolve(url.includes('ref') ? { type: 'simple', symbol: { type: 'esriSFS', color: [1, 2, 3, 255] } } : { type: 'uniqueValue', field1: 't', uniqueValueInfos: [] })
    )
    queryMock.queryViewportData.mockResolvedValue({ features: [{ type: 'Feature' }], capped: false, vertices: 1 })
    const job = makeJob(webmapWithLayer({ id: 'ft', title: '多', url: 'https://x/FeatureServer', layerType: 'ArcGISFeatureLayer' }))
    await renderWebmap(job, f)
    expect(queryMock.queryViewportData).toHaveBeenCalledTimes(2)
    expect(f.addGeoJson).toHaveBeenCalledTimes(2)
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('Feature 多层：参考层开关关闭时跳过 simple 层', async () => {
    const f = makeFacade()
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    webmapMock.fetchFeatureRenderer.mockImplementation((url: string) =>
      Promise.resolve(url.includes('ref') ? { type: 'simple' } : { type: 'uniqueValue', uniqueValueInfos: [] })
    )
    queryMock.queryViewportData.mockResolvedValue({ features: [{ type: 'Feature' }], capped: false, vertices: 1 })
    const job = makeJob(webmapWithLayer({ id: 'ft', title: '多', url: 'https://x/FeatureServer', layerType: 'ArcGISFeatureLayer' }), {
      isReferenceVisible: vi.fn(() => false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
  })

  it('GeoJSON 文件 → fetch + 预算 + addGeoJson', async () => {
    const f = makeFacade()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => fc([{ type: 'Feature' }]) }))
    )
    const job = makeJob(webmapWithLayer({ id: 'gj', title: 'GJ', url: 'https://x/data.geojson', layerType: 'GeoJSONLayer' }))
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('KML → 解析转换成功：addGeoJson + 样式', async () => {
    const f = makeFacade()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => '<kml><Placemark><name>P</name><Point><coordinates>10,20,0</coordinates></Point></Placemark></kml>' }))
    )
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect(f.addKmlNative).not.toHaveBeenCalled()
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('KML 转换失败 → 回退原生 KmlDataSource', async () => {
    const f = makeFacade()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<kml/>' })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    expect(f.addKmlNative).toHaveBeenCalledWith('https://x/data.kml', job.runtime)
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('KML 原生也失败 → 报错', async () => {
    const f = makeFacade({ addKmlNative: vi.fn(async () => { throw new Error('native fail') }) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<kml/>' })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('KML 图层加载失败：KML')
  })

  it('数据总量超预算 → 跳过后续图层并提示', async () => {
    const f = makeFacade()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => null })))
    ogcMock.fetchOgcFeatureGeoJSON.mockResolvedValue(fc(Array.from({ length: 2000 }, () => ({ type: 'Feature' }))))
    const layers = Array.from({ length: 5 }, (_, i) => ({ id: 'w' + i, title: 'W' + i, url: 'https://x/wfs', layerType: 'WFS' }))
    const job = makeJob({ baseMap: { baseMapLayers: [] }, operationalLayers: layers })
    await renderWebmap(job, f)
    // 4 层各截断到 1500 后 remaining=500，第 5 层 remaining<=0 被省略
    expect(f.addGeoJson).toHaveBeenCalledTimes(4)
    expect(job.onNote).toHaveBeenCalledWith('数据总量过大，已省略部分图层')
  })

  it('visibility=false 的图层被跳过', async () => {
    const f = makeFacade({ addWebLayerImagery: vi.fn(async () => true) })
    const job = makeJob(
      webmapWithLayer({ id: 'hid', title: 'Hidden', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer', visibility: false })
    )
    await renderWebmap(job, f)
    expect(f.addWebLayerImagery).not.toHaveBeenCalled()
  })

  it('业务层超限 → 提示仅渲染前 N 个', async () => {
    const f = makeFacade()
    const layers = Array.from({ length: 8 }, (_, i) => ({ id: 'm' + i, title: 'M' + i, url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    const job = makeJob({ baseMap: { baseMapLayers: [] }, operationalLayers: layers })
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('此地图含多个业务图层，仅渲染前 5 个（略过 3 个）')
  })
})

describe('renderWebmap：相机', () => {
  it('webmap 自带 viewpoint → flyTo 一次并标记 flew', async () => {
    const f = makeFacade()
    const job = makeJob({
      baseMap: { baseMapLayers: [] },
      operationalLayers: [],
      initialState: {
        viewpoint: { camera: { position: { x: 10, y: 20, z: 1000, spatialReference: { wkid: 4326 } }, heading: 30, tilt: 45 } },
      },
    })
    await renderWebmap(job, f)
    expect(job.markFlew).toHaveBeenCalledTimes(1)
    expect(f.flyTo).toHaveBeenCalledTimes(1)
    expect(f.flyTo.mock.calls[0][0]).toMatchObject({ destination: { tag: 'fromDegrees', args: [10, 20, 1000] } })
  })

  it('无 viewpoint → flyToHome；已 flew 不再重复', async () => {
    const f = makeFacade()
    const job = makeJob({ baseMap: { baseMapLayers: [] }, operationalLayers: [] })
    await renderWebmap(job, f)
    expect(f.flyToHome).toHaveBeenCalledTimes(1)

    const job2 = makeJob({ baseMap: { baseMapLayers: [] }, operationalLayers: [] }, { hasFlew: vi.fn(() => true) })
    await renderWebmap(job2, f)
    expect(job2.markFlew).not.toHaveBeenCalled()
    expect(f.flyToHome).toHaveBeenCalledTimes(1)
  })

  it('Feature 数据范围不在视口内 → flyToExtent', async () => {
    const f = makeFacade({ viewEnvelope: vi.fn(() => ({ west: -10, south: -10, east: 10, north: 10 })) })
    fqMock.resolveFeatureService.mockResolvedValue(
      makeFeatureService(['https://x/FeatureServer/0'], { west: 100, south: 10, east: 120, north: 30, wkid: 4326 })
    )
    const job = makeJob(webmapWithLayer({ id: 'ft', title: 'Q', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    await renderWebmap(job, f)
    expect(f.flyToExtent).toHaveBeenCalledWith({ west: 100, south: 10, east: 120, north: 30, wkid: 4326 })
  })
})

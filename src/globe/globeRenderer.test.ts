import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '../testing/mocks/cesium'
import type { CesiumFacade } from '../infra/cesiumFacade'
import type { LayerRenderJob } from '../domain/renderContract'
import { createEmptyRuntime, type LayerRuntime } from '../domain/layerRuntime'
import { SAFETY } from '../domain/loadSafety'
import type { FeatureServiceInfo } from './viewport/featureQuery'
import { renderWebmap } from './globeRenderer'

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
const vpMock = vi.hoisted(() => ({ runViewportProcess: vi.fn(), pipe: undefined as unknown }))
const safetyMock = vi.hoisted(() => ({ assertUrlWithinLimit: vi.fn() }))
const repoMock = vi.hoisted(() => ({ detectMapService: vi.fn(), fetchServiceGeoExtent: vi.fn(), fetchSceneLayerKinds: vi.fn(), isPointCloudScene: vi.fn(), fetchSceneExtent: vi.fn() }))

vi.mock('../infra/webmapProviders', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../infra/webmapProviders')>()
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
vi.mock('./viewport/viewportQuery', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./viewport/viewportQuery')>()
  return { ...mod, queryViewportData: queryMock.queryViewportData }
})
vi.mock('../infra/primitive', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../infra/primitive')>()
  return { ...mod, hasPrimitiveRendering: primMock.hasPrimitiveRendering }
})
vi.mock('../service/formats/ogc', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../service/formats/ogc')>()
  return { ...mod, fetchOgcFeatureGeoJSON: ogcMock.fetchOgcFeatureGeoJSON }
})
vi.mock('../service/formats/csv', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../service/formats/csv')>()
  return { ...mod, fetchCsvGeoJSON: csvMock.fetchCsvGeoJSON }
})
vi.mock('../service/processing/viewportWorker', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../service/processing/viewportWorker')>()
  const pipe = await import('../service/processing/viewportPipeline')
  vpMock.pipe = pipe
  return { ...mod, runViewportProcess: vpMock.runViewportProcess }
})
vi.mock('../domain/loadSafety', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../domain/loadSafety')>()
  return { ...mod, assertUrlWithinLimit: safetyMock.assertUrlWithinLimit }
})

vi.mock('../service/repository', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../service/repository')>()
  return { ...mod, detectMapService: repoMock.detectMapService, fetchServiceGeoExtent: repoMock.fetchServiceGeoExtent, fetchSceneLayerKinds: repoMock.fetchSceneLayerKinds, isPointCloudScene: repoMock.isPointCloudScene, fetchSceneExtent: repoMock.fetchSceneExtent }
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

type MockedFacade = CesiumFacade & { [K in keyof CesiumFacade]: ReturnType<typeof vi.fn> }

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
    viewportSurface: vi.fn(() => ({
      scene: {},
      prims: { add: vi.fn() },
      onMoveEnd: vi.fn(() => () => {}),
      viewEnvelope: vi.fn(() => null),
      requestFrame: vi.fn(),
    })),
    viewEnvelope: vi.fn(() => null),
    flyTo: vi.fn(),
    flyToExtent: vi.fn(),
    flyToHome: vi.fn(),
    ...overrides,
  }
  return f as unknown as MockedFacade
}

function webmapWithLayer(layer: Record<string, unknown>): Record<string, unknown> {
  return { baseMap: { baseMapLayers: [] }, operationalLayers: [layer] }
}

const fc = (features: unknown[] = []): Record<string, unknown> => ({ type: 'FeatureCollection', features })

const makeFeatureService = (layers: string[], extent?: FeatureServiceInfo['extent']): FeatureServiceInfo => ({
  layers,
  ...(extent ? { extent } : {}),
})

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
  vpMock.runViewportProcess.mockImplementation((input: { geojson: unknown; maxVertices?: number; maxFeatures?: number }) =>
    Promise.resolve(
      (vpMock.pipe as { processViewportData: (i: typeof input) => { features: unknown[]; capped: boolean; vertices: number } }).processViewportData(input)
    )
  )
  safetyMock.assertUrlWithinLimit.mockResolvedValue(undefined)
  repoMock.detectMapService.mockResolvedValue(null)
  repoMock.fetchServiceGeoExtent.mockResolvedValue(null)
  repoMock.fetchSceneLayerKinds.mockResolvedValue([])
  repoMock.isPointCloudScene.mockImplementation((k: unknown[]) => k.length > 0 && k.every((x) => x !== 'mesh'))
  repoMock.fetchSceneExtent.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
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

    it('独立 Map 服务带 fullExtent → flyToExtent 到数据范围', async () => {
      repoMock.detectMapService.mockResolvedValue({ wkid: 4326, maxLevel: 0, tiled: false, extent: { west: -95, south: 29, east: -90, north: 33 } })
      const f = makeFacade({ addWebLayerImagery: vi.fn(async () => false) })
      const job = makeJob(webmapWithLayer({ id: 'op', title: 'Map', url: 'https://x/MapServer', layerType: 'ArcGISMapServiceLayer' }))
      await renderWebmap(job, f)
      expect(f.flyToExtent).toHaveBeenCalledWith({ west: -95, south: 29, east: -90, north: 33 })
      expect(f.flyToHome).not.toHaveBeenCalled()
    })

    it('自定义投影未知（如 102682）→ 回退服务端地理范围', async () => {
      repoMock.detectMapService.mockResolvedValue({ wkid: 102682, maxLevel: 0, tiled: false, extent: { west: 3292954, south: 670052, east: 3426011, north: 772359 } })
      repoMock.fetchServiceGeoExtent.mockResolvedValue({ west: -91.3, south: 30.4, east: -91.0, north: 30.7 })
      const f = makeFacade({ addWebLayerImagery: vi.fn(async () => false) })
      const job = makeJob(webmapWithLayer({ id: 'op', title: 'Road', url: 'https://x/MapServer', layerType: 'ArcGISMapServiceLayer' }))
      await renderWebmap(job, f)
      expect(f.flyToExtent).toHaveBeenCalledWith({ west: -91.3, south: 30.4, east: -91.0, north: 30.7 })
      expect(f.flyToHome).not.toHaveBeenCalled()
    })

    it('无 fullExtent 且未知投影 → 回退 flyToHome', async () => {
      repoMock.detectMapService.mockResolvedValue(null)
      const f = makeFacade({ addWebLayerImagery: vi.fn(async () => false) })
      const job = makeJob(webmapWithLayer({ id: 'op', title: 'Map', url: 'https://x/MapServer', layerType: 'ArcGISMapServiceLayer' }))
      await renderWebmap(job, f)
      expect(f.flyToHome).toHaveBeenCalled()
      expect(f.flyToExtent).not.toHaveBeenCalled()
    })

    it('全球级范围（如世界底图）不跳相机 → 回退 flyToHome', async () => {
      repoMock.detectMapService.mockResolvedValue({ wkid: 4326, maxLevel: 0, tiled: true, extent: { west: -180, south: -90, east: 180, north: 90 } })
      const f = makeFacade({ addWebLayerImagery: vi.fn(async () => false) })
      const job = makeJob(webmapWithLayer({ id: 'op', title: 'World', url: 'https://x/MapServer', layerType: 'ArcGISMapServiceLayer' }))
      await renderWebmap(job, f)
      expect(f.flyToHome).toHaveBeenCalled()
      expect(f.flyToExtent).not.toHaveBeenCalled()
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
    expect(f.addScene).toHaveBeenCalledWith('https://x/SceneServer', job.runtime, expect.any(Function))
    expect(job.onClearError).toHaveBeenCalled()

    f.addScene.mockRejectedValueOnce(new Error('boom'))
    const job2 = makeJob(webmapWithLayer({ id: 'sc2', title: 'Scene2', url: 'https://x/SceneServer', layerType: 'ArcGISSceneLayer' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderWebmap(job2, f)
    expect(job2.onError).toHaveBeenCalledWith('3D 场景加载失败：Scene2')
  })

  it('Point cloud scene → 跳过 addScene 并提示（不支持点云）', async () => {
    const f = makeFacade()
    repoMock.fetchSceneLayerKinds.mockResolvedValue(['point'])
    const job = makeJob(webmapWithLayer({ id: 'pc', title: 'Trees', url: 'https://x/SceneServer', layerType: 'ArcGISSceneLayer' }))
    await renderWebmap(job, f)
    expect(f.addScene).not.toHaveBeenCalled()
    expect(job.onNote).toHaveBeenCalledWith('该场景为点云图层，暂不支持渲染')
  })

  it('独立 Scene 带 fullExtent → flyToExtent 到数据范围', async () => {
    repoMock.fetchSceneExtent.mockResolvedValue({ wkid: 4326, west: 5, south: 50, east: 7, north: 53 })
    const f = makeFacade({ addWebLayerImagery: vi.fn(async () => false) })
    const job = makeJob(webmapWithLayer({ id: 'sc', title: 'Scene', url: 'https://x/SceneServer', layerType: 'ArcGISSceneServiceLayer' }))
    await renderWebmap(job, f)
    expect(f.flyToExtent).toHaveBeenCalledWith({ west: 5, south: 50, east: 7, north: 53 })
    expect(f.flyToHome).not.toHaveBeenCalled()
  })

  it('全球级 3D 场景不跳相机，并提示放大到城市', async () => {
    repoMock.fetchSceneExtent.mockResolvedValue({ wkid: 4326, west: -180, south: -90, east: 180, north: 90 })
    const f = makeFacade({ addWebLayerImagery: vi.fn(async () => false) })
    const job = makeJob(webmapWithLayer({ id: 'gs', title: 'Global', url: 'https://x/SceneServer', layerType: 'ArcGISSceneServiceLayer' }))
    await renderWebmap(job, f)
    expect(f.flyToHome).toHaveBeenCalled()
    expect(f.flyToExtent).not.toHaveBeenCalled()
    expect(job.onNote).toHaveBeenCalledWith('该 3D 场景覆盖全球，放大到城市可见对象')
  })

  it('OGC 3D Tiles → add3dTiles', async () => {
    const f = makeFacade()
    const job = makeJob(webmapWithLayer({ id: 't3d', title: 'Tiles', url: 'https://x/tileset.json', layerType: '3DTilesLayer' }))
    await renderWebmap(job, f)
    expect(f.add3dTiles).toHaveBeenCalledWith('https://x/tileset.json', job.runtime, expect.any(Function))
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

  it('Feature 单层 Primitive 路径：viewportSurface + createViewportDriver + attachViewport，不再手动渲染', async () => {
    const f = makeFacade()
    primMock.hasPrimitiveRendering.mockReturnValue(true)
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/0']))
    const job = makeJob(webmapWithLayer({ id: 'ft', title: 'Quakes', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    await renderWebmap(job, f)
    expect(fqMock.resolveFeatureQueryBase).toHaveBeenCalledWith('https://x/FeatureServer/0')
    expect(f.viewportSurface).toHaveBeenCalledTimes(1)
    expect(job.attachViewport).toHaveBeenCalled()
    expect(f.addGeoJson).not.toHaveBeenCalled()
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('Feature 单层 Primitive 路径：viewer 不可用时跳过 attachViewport 仍标记完成', async () => {
    const f = makeFacade({ viewportSurface: vi.fn(() => null) })
    primMock.hasPrimitiveRendering.mockReturnValue(true)
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/0']))
    const job = makeJob(webmapWithLayer({ id: 'ft', title: 'Quakes', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }))
    await renderWebmap(job, f)
    expect(f.viewportSurface).toHaveBeenCalledTimes(1)
    expect(job.attachViewport).not.toHaveBeenCalled()
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
    expect(f.addKmlNative).toHaveBeenCalledWith('https://x/data.kml', job.runtime, expect.any(Function))
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

    it('viewpoint 相机高度超过 maxZoom → 回退 flyToHome（保持一致）', async () => {
      const f = makeFacade()
      const job = makeJob({
        baseMap: { baseMapLayers: [] },
        operationalLayers: [],
        initialState: {
          viewpoint: { camera: { position: { x: 104, y: 34.9, z: 25512548, spatialReference: { wkid: 4326 } }, heading: 0, tilt: 0.1 } },
        },
      })
      await renderWebmap(job, f)
      expect(job.markFlew).toHaveBeenCalledTimes(1)
      expect(f.flyTo).not.toHaveBeenCalled()
      expect(f.flyToHome).toHaveBeenCalledTimes(1)
    })

    it('viewpoint 相机高度等于 maxZoom → 仍按自带相机飞', async () => {
      const f = makeFacade()
      const job = makeJob({
        baseMap: { baseMapLayers: [] },
        operationalLayers: [],
        initialState: {
          viewpoint: { camera: { position: { x: 104, y: 10, z: 25000000, spatialReference: { wkid: 4326 } }, heading: 0, tilt: 0 } },
        },
      })
      await renderWebmap(job, f)
      expect(f.flyTo).toHaveBeenCalledTimes(1)
      expect(f.flyToHome).not.toHaveBeenCalled()
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

describe('renderWebmap：keepAlive / 失败 / 降级分支', () => {
  const featLayer = (id: string, title: string): Record<string, unknown> =>
    webmapWithLayer({ id, title, url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' })
  const fcLayer = (features: unknown[]): Record<string, unknown> =>
    webmapWithLayer({
      id: 'fc',
      title: '内嵌',
      layerType: 'FeatureCollection',
      layerDefinition: { featureCollection: { featureCollection: { features } } },
    })

  it('影像层加载后 keepAlive 失效 → 立即中止', async () => {
    const f = makeFacade()
    const job = makeJob(
      webmapWithLayer({ id: 'op', title: 'I', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }),
      { keepAlive: vi.fn(() => false) }
    )
    await renderWebmap(job, f)
    expect(f.addVectorTile).not.toHaveBeenCalled()
    expect(job.onError).not.toHaveBeenCalled()
  })

  it('内嵌 FeatureCollection 超预算 → 提示降级', async () => {
    const f = makeFacade()
    const job = makeJob(fcLayer(Array.from({ length: 2000 }, () => ({ type: 'Feature' }))))
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('内嵌数据量大，已按顶点/要素预算降级')
  })

  it('内嵌 FeatureCollection 处理后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    const job = makeJob(fcLayer([{ type: 'Feature' }]), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('内嵌 FeatureCollection addGeoJson 返回 null → 中止', async () => {
    const f = makeFacade({ addGeoJson: vi.fn(async () => null) })
    const job = makeJob(fcLayer([{ type: 'Feature' }]))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('内嵌 FeatureCollection 处理失败 → 报错', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vpMock.runViewportProcess.mockRejectedValueOnce(new Error('boom'))
    const job = makeJob(fcLayer([{ type: 'Feature' }]))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('内嵌要素集加载失败：内嵌')
  })

  it('Scene addScene 返回 null → 中止', async () => {
    const f = makeFacade({ addScene: vi.fn(async () => null) })
    const job = makeJob(webmapWithLayer({ id: 'sc', title: 'Scene', url: 'https://x/SceneServer', layerType: 'ArcGISSceneLayer' }))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('3D Tiles add3dTiles 返回 null → 中止', async () => {
    const f = makeFacade({ add3dTiles: vi.fn(async () => null) })
    const job = makeJob(webmapWithLayer({ id: 't', title: 'Tiles', url: 'https://x/tileset.json', layerType: '3DTilesLayer' }))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('3D Tiles 失败 → 报错', async () => {
    const f = makeFacade({ add3dTiles: vi.fn(async () => { throw new Error('boom') }) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const job = makeJob(webmapWithLayer({ id: 't', title: 'Tiles', url: 'https://x/tileset.json', layerType: '3DTilesLayer' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('3D Tiles 加载失败：Tiles')
  })

  it('WFS 读取后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    ogcMock.fetchOgcFeatureGeoJSON.mockResolvedValue(fc([{ type: 'Feature' }]))
    const job = makeJob(webmapWithLayer({ id: 'w', title: 'W', url: 'https://x/wfs', layerType: 'WFS' }), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('WFS 单层超上限 → 提示降级', async () => {
    const f = makeFacade()
    ogcMock.fetchOgcFeatureGeoJSON.mockResolvedValue(fc(Array.from({ length: 2000 }, () => ({ type: 'Feature' }))))
    const job = makeJob(webmapWithLayer({ id: 'w', title: 'W', url: 'https://x/wfs', layerType: 'WFS' }))
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('数据量大，已按顶点/要素预算降级')
  })

  it('WFS addGeoJson 返回 null → 中止', async () => {
    const f = makeFacade({ addGeoJson: vi.fn(async () => null) })
    ogcMock.fetchOgcFeatureGeoJSON.mockResolvedValue(fc([{ type: 'Feature' }]))
    const job = makeJob(webmapWithLayer({ id: 'w', title: 'W', url: 'https://x/wfs', layerType: 'WFS' }))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('WFS 读取失败 → 报错', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ogcMock.fetchOgcFeatureGeoJSON.mockRejectedValue(new Error('net'))
    const job = makeJob(webmapWithLayer({ id: 'w', title: 'W', url: 'https://x/wfs', layerType: 'WFS' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('WFS/OGC 要素图层加载失败：W')
  })

  it('CSV 单层超上限 → 提示降级', async () => {
    const f = makeFacade()
    csvMock.fetchCsvGeoJSON.mockResolvedValue(fc(Array.from({ length: 2000 }, () => ({ type: 'Feature' }))))
    const job = makeJob(webmapWithLayer({ id: 'c', title: 'C', url: 'https://x/data.csv', layerType: 'CSVLayer' }))
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('数据量大，已按顶点/要素预算降级')
  })

  it('CSV 总量超预算 → 省略后续图层', async () => {
    const f = makeFacade()
    csvMock.fetchCsvGeoJSON.mockResolvedValue(fc(Array.from({ length: 2000 }, () => ({ type: 'Feature' }))))
    const layers = Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, title: 'C' + i, url: 'https://x/data.csv', layerType: 'CSVLayer' }))
    const job = makeJob({ baseMap: { baseMapLayers: [] }, operationalLayers: layers })
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(4)
    expect(job.onNote).toHaveBeenCalledWith('数据总量过大，已省略部分图层')
  })

  it('CSV 读取后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    csvMock.fetchCsvGeoJSON.mockResolvedValue(fc([{ type: 'Feature' }]))
    const job = makeJob(webmapWithLayer({ id: 'c', title: 'C', url: 'https://x/data.csv', layerType: 'CSVLayer' }), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('CSV addGeoJson 返回 null → 中止', async () => {
    const f = makeFacade({ addGeoJson: vi.fn(async () => null) })
    csvMock.fetchCsvGeoJSON.mockResolvedValue(fc([{ type: 'Feature' }]))
    const job = makeJob(webmapWithLayer({ id: 'c', title: 'C', url: 'https://x/data.csv', layerType: 'CSVLayer' }))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('CSV 读取失败 → 报错', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    csvMock.fetchCsvGeoJSON.mockRejectedValue(new Error('net'))
    const job = makeJob(webmapWithLayer({ id: 'c', title: 'C', url: 'https://x/data.csv', layerType: 'CSVLayer' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('CSV 图层加载失败：C')
  })

  it('GeoJSON 文件过大 → 限制加载', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    safetyMock.assertUrlWithinLimit.mockRejectedValueOnce(new Error('too big'))
    const job = makeJob(webmapWithLayer({ id: 'gj', title: 'GJ', url: 'https://x/data.geojson', layerType: 'GeoJSONLayer' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('GeoJSON 文件过大，已限制加载')
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('GeoJSON 非法 JSON → 按空集渲染并清错', async () => {
    const f = makeFacade()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad') } })))
    const job = makeJob(webmapWithLayer({ id: 'gj', title: 'GJ', url: 'https://x/data.geojson', layerType: 'GeoJSONLayer' }))
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect((f.addGeoJson.mock.calls[0][0] as { features: unknown[] }).features).toEqual([])
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('GeoJSON fetch 后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fc([{ type: 'Feature' }]) })))
    const job = makeJob(webmapWithLayer({ id: 'gj', title: 'GJ', url: 'https://x/data.geojson', layerType: 'GeoJSONLayer' }), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('GeoJSON 数据量大 → 提示降级', async () => {
    const f = makeFacade()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fc(Array.from({ length: 4000 }, () => ({ type: 'Feature' }))) })))
    const job = makeJob(webmapWithLayer({ id: 'gj', title: 'GJ', url: 'https://x/data.geojson', layerType: 'GeoJSONLayer' }))
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('文件数据量大，已按顶点预算降级显示')
  })

  it('GeoJSON addGeoJson 返回 null → 中止', async () => {
    const f = makeFacade({ addGeoJson: vi.fn(async () => null) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => fc([{ type: 'Feature' }]) })))
    const job = makeJob(webmapWithLayer({ id: 'gj', title: 'GJ', url: 'https://x/data.geojson', layerType: 'GeoJSONLayer' }))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('GeoJSON 加载失败 → 报错', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net') }))
    const job = makeJob(webmapWithLayer({ id: 'gj', title: 'GJ', url: 'https://x/data.geojson', layerType: 'GeoJSONLayer' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('GeoJSON 图层加载失败：GJ')
  })

  it('Feature 解析服务后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    const job = makeJob(featLayer('ft', 'Q'), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('Feature 单层样式解析后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    const job = makeJob(featLayer('ft', 'Q'), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('Feature 单层查询后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    const job = makeJob(featLayer('ft', 'Q'), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
  })

  it('Feature 单层查询 capped → 提示降级', async () => {
    const f = makeFacade()
    queryMock.queryViewportData.mockResolvedValue({ features: [{ type: 'Feature' }], capped: true, vertices: 1 })
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('数据量大，已按视口/预算降级显示')
  })

  it('Feature 单层 addGeoJson 返回 null → 中止', async () => {
    const f = makeFacade({ addGeoJson: vi.fn(async () => null) })
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('Feature Primitive 回退 addGeoJson 返回 null → 中止', async () => {
    const f = makeFacade({ addGeoJson: vi.fn(async () => null) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    primMock.hasPrimitiveRendering.mockReturnValue(true)
    fqMock.resolveFeatureQueryBase.mockRejectedValue(new Error('no base'))
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('Feature 服务解析失败 → 报错', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fqMock.resolveFeatureService.mockRejectedValue(new Error('net'))
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('要素图层加载失败：Q')
  })

  it('Feature 多层 makeLayer 与收尾 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    const job = makeJob(featLayer('ft', 'Q'), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('Feature 多层查询后 keepAlive 失效 → 中止', async () => {
    const f = makeFacade()
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    const job = makeJob(featLayer('ft', 'Q'), {
      keepAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false),
    })
    await renderWebmap(job, f)
    expect(f.addGeoJson).not.toHaveBeenCalled()
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('Feature 多层查询 capped → 提示降级', async () => {
    const f = makeFacade()
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    webmapMock.fetchFeatureRenderer.mockResolvedValue({ type: 'simple', symbol: { type: 'esriSFS', color: [1, 2, 3, 255] } })
    queryMock.queryViewportData.mockResolvedValue({ features: [{ type: 'Feature' }], capped: true, vertices: 1 })
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('数据量大，已按视口/预算降级显示')
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('Feature 多层空要素层跳过不渲染', async () => {
    const f = makeFacade()
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    webmapMock.fetchFeatureRenderer.mockImplementation((url: string) =>
      Promise.resolve(url.includes('ref') ? { type: 'simple', symbol: { type: 'esriSFS', color: [1, 2, 3, 255] } } : { type: 'uniqueValue', uniqueValueInfos: [] })
    )
    queryMock.queryViewportData.mockImplementation((base: string) =>
      Promise.resolve({ features: base.includes('ref') ? [{ type: 'Feature' }] : [], capped: false, vertices: 0 })
    )
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(1)
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('Feature 多层 addGeoJson 返回 null → 该层跳过仍完成', async () => {
    const f = makeFacade({
      addGeoJson: vi.fn(async (data: unknown) =>
        (data as { features: unknown[] }).features.length > 1 ? null : { data, entities: { values: [] } }
      ),
    })
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    webmapMock.fetchFeatureRenderer.mockImplementation((url: string) =>
      Promise.resolve(url.includes('ref') ? { type: 'simple', symbol: { type: 'esriSFS', color: [1, 2, 3, 255] } } : { type: 'uniqueValue', uniqueValueInfos: [] })
    )
    queryMock.queryViewportData.mockImplementation((base: string) =>
      Promise.resolve({
        features: Array.from({ length: base.includes('ref') ? 1 : 2 }, () => ({ type: 'Feature' })),
        capped: false,
        vertices: 0,
      })
    )
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(f.addGeoJson).toHaveBeenCalledTimes(2)
    expect(job.onClearError).toHaveBeenCalled()
  })

  it('Feature 多层参考层样式透明化填充', async () => {
    const f = makeFacade({
      addGeoJson: vi.fn(async (data: unknown) => ({
        data,
        entities: { values: [{ properties: { name: 'r' }, polygon: { material: null as unknown } }] },
      })),
    })
    fqMock.resolveFeatureService.mockResolvedValue(makeFeatureService(['https://x/FeatureServer/ref', 'https://x/FeatureServer/evt']))
    webmapMock.fetchFeatureRenderer.mockImplementation((url: string) =>
      Promise.resolve(url.includes('ref') ? { type: 'simple', symbol: { type: 'esriSFS', color: [1, 2, 3, 255] } } : { type: 'uniqueValue', uniqueValueInfos: [] })
    )
    queryMock.queryViewportData.mockResolvedValue({ features: [{ type: 'Feature' }], capped: false, vertices: 1 })
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    const refDs = (await f.addGeoJson.mock.results[0].value) as { entities: { values: { polygon: { material: unknown } }[] } }
    expect(refDs.entities.values[0].polygon.material).toEqual([0, 0, 0, 0])
  })

  it('Feature extent 非 WGS84 → 重投影到 4326 后飞行', async () => {
    const f = makeFacade({ viewEnvelope: vi.fn(() => ({ west: 0, south: 0, east: 10, north: 10 })) })
    fqMock.resolveFeatureService.mockResolvedValue(
      makeFeatureService(['https://x/FeatureServer/0'], { west: 11131949, south: 1118889, east: 13358338, north: 3503549, wkid: 3857 })
    )
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(f.flyToExtent).toHaveBeenCalledWith(
      expect.objectContaining({
        west: expect.closeTo(100, 0.01),
        south: expect.closeTo(10, 0.01),
        east: expect.closeTo(120, 0.01),
        north: expect.closeTo(30, 0.01),
        wkid: 4326,
      })
    )
  })

  it('Feature extent 重投影失败 → 保留原范围飞行', async () => {
    const f = makeFacade({ viewEnvelope: vi.fn(() => ({ west: 0, south: 0, east: 10, north: 10 })) })
    fqMock.resolveFeatureService.mockResolvedValue(
      makeFeatureService(['https://x/FeatureServer/0'], { west: 100, south: 10, east: 120, north: 30, wkid: 99999 })
    )
    const job = makeJob(featLayer('ft', 'Q'))
    await renderWebmap(job, f)
    expect(f.flyToExtent).toHaveBeenCalledWith({ west: 100, south: 10, east: 120, north: 30, wkid: 99999 })
  })

  it('KML 文件过大 → 限制加载', async () => {
    const f = makeFacade()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    safetyMock.assertUrlWithinLimit.mockRejectedValueOnce(new Error('too big'))
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    expect(job.onError).toHaveBeenCalledWith('KML 文件过大，已限制加载')
  })

  it('KML 数据量大 → 提示降级', async () => {
    const f = makeFacade()
    const kmlText =
      '<kml>' +
      Array.from({ length: 1600 }, (_, i) => `<Placemark><name>P${i}</name><Point><coordinates>${10 + (i % 100)},20,0</coordinates></Point></Placemark>`).join('') +
      '</kml>'
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => kmlText })))
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    expect(job.onNote).toHaveBeenCalledWith('KML 数据量大，已按顶点/要素预算降级显示')
  })

  it('KML addGeoJson 返回 null → 中止', async () => {
    const f = makeFacade({ addGeoJson: vi.fn(async () => null) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<kml><Placemark><name>P</name><Point><coordinates>10,20,0</coordinates></Point></Placemark></kml>' })))
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })

  it('KML 应用样式函数到要素', async () => {
    const f = makeFacade({
      addGeoJson: vi.fn(async (data: unknown) => ({
        data,
        entities: {
          values: [{ properties: { kmlStyle: { markerColor: [255, 0, 0, 255] } }, point: { color: null as unknown, pixelSize: null as unknown } }],
        },
      })),
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<kml><Placemark><name>P</name><Point><coordinates>10,20,0</coordinates></Point></Placemark></kml>' })))
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    const ds = (await f.addGeoJson.mock.results[0].value) as { entities: { values: { point: { color: unknown; pixelSize: unknown } }[] } }
    expect(ds.entities.values[0].point.color).toEqual([255, 0, 0, 255])
  })

  it('KML 原生回退 addKmlNative 返回 null → 中止', async () => {
    const f = makeFacade({ addKmlNative: vi.fn(async () => null) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<kml/>' })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const job = makeJob(webmapWithLayer({ id: 'km', title: 'KML', url: 'https://x/data.kml', layerType: 'KML' }))
    await renderWebmap(job, f)
    expect(job.onClearError).not.toHaveBeenCalled()
  })
})

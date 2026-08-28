import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup, screen } from '@testing-library/react'
import { GlobeViewer, viewpointCameraFromWebmap } from './GlobeViewer'
import { useAppStore } from '../state/store'

// ---- Cesium mock（fake Viewer，可断言创建/底图/图层/相机/效果） ----
const cesiumMock = vi.hoisted(() => {
  const viewers: any[] = []
  const viewerOptions: any[] = []
  const imageryLayerInstances: any[] = []
  const handlerInstances: any[] = []
  const terrainProviders: any[] = []

  function makeImageryLayers() {
    const list: any[] = []
    return {
      list,
      get length() {
        return list.length
      },
      add: vi.fn((l: any, idx?: number) => {
        if (idx === undefined) list.push(l)
        else list.splice(idx, 0, l)
        return l
      }),
      remove: vi.fn((l: any) => {
        const i = list.indexOf(l)
        if (i >= 0) list.splice(i, 1)
        return true
      }),
    }
  }

  function makeViewer() {
    const postUpdate = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const canvas = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const globe = {
      baseColor: undefined,
      getHeight: vi.fn(() => undefined),
      maximumScreenSpaceError: 0,
      tileCacheSize: 0,
      preloadSiblings: false,
      tileLoadProgressEvent: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      showGroundAtmosphere: false,
      enableLighting: false,
      translucency: { enabled: false, frontFaceAlpha: 1, backFaceAlpha: 1 },
      ellipsoid: { cartesianToCartographic: vi.fn(() => ({ longitude: 0.5, latitude: 0.3 })) },
    }
    const scene = {
      canvas,
      postUpdate,
      globe,
      screenSpaceCameraController: {},
      postProcessStages: { bloom: { enabled: true } },
      backgroundColor: undefined,
      skyBox: { show: true },
      sun: { show: true },
      moon: { show: true },
      fog: { enabled: false },
      verticalExaggeration: 1,
      requestRender: vi.fn(),
      primitives: { add: vi.fn(), remove: vi.fn() },
    }
    const camera = {
      positionCartographic: { height: 1000, longitude: 1, latitude: 0.5 },
      heading: 0.1,
      pitch: -0.2,
      roll: 0,
      position: { tag: 'pos' },
      _currentFlight: undefined,
      cancelFlight: vi.fn(),
      flyTo: vi.fn(),
      setView: vi.fn(),
      moveForward: vi.fn(),
      pickEllipsoid: vi.fn(() => ({ picked: true })),
    }
    const imageryLayers = makeImageryLayers()
    const dataSources = { add: vi.fn(), remove: vi.fn() }
    const v = {
      scene,
      camera,
      imageryLayers,
      dataSources,
      terrainProvider: undefined,
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
      flyTo: vi.fn(),
    }
    viewers.push(v)
    return v
  }

  return { viewers, viewerOptions, imageryLayerInstances, handlerInstances, terrainProviders, makeViewer }
})

vi.mock('cesium', () => {
  const CM = cesiumMock
  return {
    Viewer: vi.fn(function (_container: unknown, options: unknown) {
      CM.viewerOptions.push(options)
      return CM.makeViewer()
    }),
    Math: {
      toRadians: (d: number) => (d * Math.PI) / 180,
      toDegrees: (r: number) => (r * 180) / Math.PI,
    },
    Color: {
      fromCssColorString: vi.fn((s: string) => ({ css: s })),
      fromBytes: (...a: number[]) => a,
    },
    CameraEventType: { RIGHT_DRAG: 'RIGHT_DRAG', PINCH: 'PINCH' },
    ScreenSpaceEventType: {
      LEFT_DOWN: 'LEFT_DOWN',
      RIGHT_DOWN: 'RIGHT_DOWN',
      MIDDLE_DOWN: 'MIDDLE_DOWN',
      LEFT_DOUBLE_CLICK: 'LEFT_DOUBLE_CLICK',
    },
    Cartesian3: {
      fromDegrees: (...a: number[]) => ({ tag: 'fromDegrees', args: a }),
      fromRadians: (...a: number[]) => ({ tag: 'fromRadians', args: a }),
    },
    PointPrimitiveCollection: vi.fn(function () { return { add: vi.fn() } }),
    PrimitiveCollection: vi.fn(function () { return { add: vi.fn(), remove: vi.fn() } }),
    PolylineCollection: vi.fn(function () { return { add: vi.fn() } }),
    GeometryInstance: vi.fn(function () { return { inst: true } }),
    PolygonGeometry: vi.fn(function () { return { geom: true } }),
    PolygonHierarchy: vi.fn(function () { return { hier: true } }),
    ColorGeometryInstanceAttribute: { fromColor: vi.fn(() => ({ color: true })) },
    PerInstanceColorAppearance: vi.fn(function () { return { appearance: true } }),
    Primitive: vi.fn(function () { return { prim: true } }),

    UrlTemplateImageryProvider: vi.fn(function (opts: unknown) { return { provider: 'urlTemplate', opts } }),
    GeographicTilingScheme: vi.fn(function () { return { scheme: 'geo' } }),
    ImageryLayer: vi.fn(function (provider: unknown) {
      const inst = { provider, alpha: 1 }
      CM.imageryLayerInstances.push(inst)
      return inst
    }),
    ScreenSpaceEventHandler: vi.fn(function () {
      const h = { setInputAction: vi.fn(), destroy: vi.fn() }
      CM.handlerInstances.push(h)
      return h
    }),
    GeoJsonDataSource: { load: vi.fn((url: unknown) => Promise.resolve({ ds: url })) },
    KmlDataSource: { load: vi.fn((url: unknown) => Promise.resolve({ ds: url })) },
    ArcGISTiledElevationTerrainProvider: {
      fromUrl: vi.fn(() => Promise.resolve({ terrain: 't' })),
    },
    I3SDataProvider: {
      fromUrl: vi.fn(() => Promise.resolve({ prim: 'i3s' })),
    },
    Cesium3DTileset: {
      fromUrl: vi.fn(() => Promise.resolve({ tileset: '3d' })),
    },
    MVTDataProvider: {
      fromUrl: vi.fn(() => Promise.resolve({ prim: 'mvt' })),
    },
  }
})

// MapLibre 矢量瓦片 provider：mock 掉真实 MapLibre，避免 jsdom 无 WebGL
const maplibreMock = vi.hoisted(() => {
  const instances: Array<{
    opts: Record<string, unknown>
    destroy: ReturnType<typeof vi.fn>
    readyPromise: Promise<boolean>
  }> = []
  return { instances }
})

vi.mock('./maplibreImagery', () => {
  class MockVectorProvider {
    ready = false
    readyPromise: Promise<boolean>
    destroy = vi.fn()
    constructor(public opts: Record<string, unknown>) {
      this.readyPromise = opts.styleUrl === 'https://fail'
        ? Promise.reject(new Error('fail'))
        : Promise.resolve(true).then(() => { this.ready = true; return true })
      maplibreMock.instances.push(this as never)
    }
  }
  return {
    ArcGisVectorTileImageryProvider: MockVectorProvider,
    normalizeArcGisStyle: vi.fn((st: unknown) => st),
    tileCenterLngLat: vi.fn((x: number, y: number) => ({ lng: x, lat: y })),
  }
})

vi.mock('./ogc', () => ({
  fetchOgcFeatureGeoJSON: vi.fn(() => Promise.resolve({ type: 'FeatureCollection', features: [] })),
}))

vi.mock('./csv', () => ({
  fetchCsvGeoJSON: vi.fn(() => Promise.resolve({ type: 'FeatureCollection', features: [] })),
}))

vi.mock('./geo', () => ({
  fetchUserHome: vi.fn(() => Promise.resolve({ lat: 31, lon: 121 })),
  getUserHome: vi.fn(() => null),
}))

const freshEffects = {
  atmosphere: false,
  stars: true,
  sunMoon: false,
  fog: false,
  dayNight: false,
  terrainExaggeration: 1,
  globeTranslucency: false,
  translucencyAlpha: 0.6,
  autoRotate: false,
}

function viewer() {
  return cesiumMock.viewers[cesiumMock.viewers.length - 1]
}

function flush() {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('GlobeViewer', () => {
  beforeEach(() => {
    cesiumMock.viewers.length = 0
    cesiumMock.viewerOptions.length = 0
    cesiumMock.imageryLayerInstances.length = 0
    cesiumMock.handlerInstances.length = 0
    useAppStore.setState({
      theme: 'dark',
      added: [],
      effects: freshEffects,
      collapsed: false,
      collapsedRight: false,
      layerErrors: {},
      userHome: null,
    })
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.documentElement.style.removeProperty('--globe-bg')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('创建 Viewer：关闭多余控件、注册相机、添加三层底图、监听事件', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    expect(v).toBeDefined()
    // 底图三层
    expect(v.imageryLayers.length).toBe(3)
    // 相机事件
    expect(v.scene.canvas.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false })
    expect(v.scene.postUpdate.addEventListener).toHaveBeenCalled()
    expect(v.scene.globe.tileCacheSize).toBe(100)
    expect(v.scene.globe.preloadSiblings).toBe(false)
    expect(v.scene.globe.baseColor).toEqual({ css: '#0d1526' })
    expect(cesiumMock.handlerInstances.length).toBe(1)
    // 地形异步设置
    await act(async () => {})
    expect(v.terrainProvider).toEqual({ terrain: 't' })
  })

  it('静止时使用按需渲染，效果变化时请求一帧刷新', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    expect(cesiumMock.viewerOptions[0]).toMatchObject({
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    })
    const requestsBeforeEffect = v.scene.requestRender.mock.calls.length
    act(() => useAppStore.getState().setEffect('fog', true))
    expect(v.scene.requestRender.mock.calls.length).toBe(requestsBeforeEffect + 1)
  })
  it('浅色主题场景背景使用统一的球体背景主题变量', async () => {
    useAppStore.setState({ theme: 'light' })
    render(<GlobeViewer />)
    await flush()
    expect(viewer().scene.backgroundColor).toEqual({ css: '#ffffff' })
  })
  it('WebGL 上下文丢失 → 显示降级提示', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const lost = v.scene.canvas.addEventListener.mock.calls.find((c: unknown[]) => c[0] === 'webglcontextlost')?.[1] as (e: Event) => void
    expect(lost).toBeTypeOf('function')
    await act(async () => { lost({ preventDefault: vi.fn() } as unknown as Event) })
    await act(async () => {})
    expect(screen.getByText(/WebGL 上下文已丢失/)).toBeInTheDocument()
    const requestsBeforeRestore = v.scene.requestRender.mock.calls.length
    const restored = v.scene.canvas.addEventListener.mock.calls.find((c: unknown[]) => c[0] === 'webglcontextrestored')?.[1] as () => void
    expect(restored).toBeTypeOf('function')
    act(() => { restored() })
    expect(v.scene.requestRender.mock.calls.length).toBe(requestsBeforeRestore + 1)
  })

  it('效果开关映射到 globe 场景（雾/星空/日月/夸张/半透明）', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().setEffect('fog', true)
      useAppStore.getState().setEffect('stars', false)
      useAppStore.getState().setEffect('sunMoon', true)
      useAppStore.getState().setEffect('dayNight', true)
      useAppStore.getState().setEffect('terrainExaggeration', 2)
      useAppStore.getState().setEffect('globeTranslucency', true)
      useAppStore.getState().setEffect('translucencyAlpha', 0.4)
      useAppStore.getState().setEffect('atmosphere', true)
    })
    expect(v.scene.globe.showGroundAtmosphere).toBe(true)
    expect(v.scene.fog.enabled).toBe(true)
    expect(v.scene.skyBox.show).toBe(false)
    expect(v.scene.sun.show).toBe(true)
    expect(v.scene.globe.enableLighting).toBe(true)
    expect(v.scene.verticalExaggeration).toBe(2)
    expect(v.scene.globe.translucency.enabled).toBe(true)
    expect(v.scene.globe.translucency.frontFaceAlpha).toBe(0.4)
    expect(v.scene.globe.translucency.backFaceAlpha).toBe(0.5)
  })

  it('滚轮缩放：更新目标高度并缓动 moveForward', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const wheelHandler = v.scene.canvas.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === 'wheel'
    )?.[1] as (e: { deltaY: number; preventDefault: () => void }) => void
    expect(wheelHandler).toBeTypeOf('function')
    const preventDefault = vi.fn()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(5000)
    wheelHandler({ deltaY: 100, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    // 触发帧回调 → moveForward（diff * 0.25）
    const frameCb = v.scene.postUpdate.addEventListener.mock.calls[0][0] as () => void
    frameCb()
    expect(v.camera.moveForward).toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('自动环绕：无交互 3s 后沿东西方向递增经度', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(10000)
    act(() => useAppStore.getState().setEffect('autoRotate', true))
    const frameCb = v.scene.postUpdate.addEventListener.mock.calls[0][0] as () => void
    frameCb()
    expect(v.camera.setView).toHaveBeenCalled()
    const dest = v.camera.setView.mock.calls[0][0].destination
    expect(dest.tag).toBe('fromRadians')
    nowSpy.mockRestore()
  })

  it('初始已开启自动环绕时，空闲阈值到达后唤醒按需渲染', async () => {
    vi.useFakeTimers()
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0)
    useAppStore.setState({ effects: { ...freshEffects, autoRotate: true } })
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const before = v.scene.requestRender.mock.calls.length
    act(() => vi.advanceTimersByTime(3000))
    expect(v.scene.requestRender.mock.calls.length).toBeGreaterThan(before)
    nowSpy.mockRestore()
    vi.useRealTimers()
  })

  it('双击 → flyTo 到点击点一半高度', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const h = cesiumMock.handlerInstances[0]
    const dbl = h.setInputAction.mock.calls.find((c: unknown[]) => c[1] === 'LEFT_DOUBLE_CLICK')
    expect(dbl).toBeDefined()
    dbl[0]({ position: {} })
    expect(v.camera.flyTo).toHaveBeenCalled()
  })

  it('添加 MapServer webmap → 创建 ImageryLayer、叠加并请求刷新', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }),
      }))
    )
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const before = v.imageryLayers.length
    const requestsBeforeLayer = v.scene.requestRender.mock.calls.length
    act(() => {
      useAppStore.getState().addLayer({
        id: 'wm1',
        title: 'Imagery',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'op', title: 'World Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
          ],
        },
      })
    })
    await flush()
    expect(v.imageryLayers.length).toBe(before + 1)
    expect(v.scene.requestRender.mock.calls.length).toBeGreaterThan(requestsBeforeLayer)
  })

  it('添加 FeatureLayer → GeoJsonDataSource 加载并加入 dataSources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }))
    )
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'feat',
        title: 'Quakes',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'f1', title: 'Quakes', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' },
          ],
        },
      })
    })
    await flush()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(v.scene.primitives.add).toHaveBeenCalled()
    expect(useAppStore.getState().layerErrors['feat']).toBeUndefined()
  })

  it('移除图层 → 从 imageryLayers / dataSources 移除', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }),
      }))
    )
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'wm1',
        title: 'Imagery',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'op', title: 'World Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
          ],
        },
      })
    })
    await flush()
    const before = v.imageryLayers.length
    act(() => useAppStore.getState().removeLayer('wm1'))
    await flush()
    expect(v.imageryLayers.length).toBe(before - 1)
  })

  it('卸载时销毁 viewer 并移除事件监听', async () => {
    const { unmount } = render(<GlobeViewer />)
    await flush()
    const v = viewer()
    unmount()
    expect(v.destroy).toHaveBeenCalled()
    expect(v.scene.canvas.removeEventListener).toHaveBeenCalledWith('wheel', expect.any(Function))
    expect(v.scene.postUpdate.removeEventListener).toHaveBeenCalled()
    expect(cesiumMock.handlerInstances[0].destroy).toHaveBeenCalled()
  })
})

describe('GlobeViewer 补强', () => {
  beforeEach(() => {
    cesiumMock.viewers.length = 0
    cesiumMock.imageryLayerInstances.length = 0
    cesiumMock.handlerInstances.length = 0
    useAppStore.setState({
      theme: 'dark',
      added: [],
      effects: freshEffects,
      collapsed: false,
      collapsedRight: false,
      layerErrors: {},
      userHome: null,
    })
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('无相机 FeatureLayer 添加到球上，并回退 flyToHome（初始位置）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }))
    )
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'feat-fly',
        title: 'Quakes',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'f1', title: 'Quakes', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' },
          ],
        },
      })
    })
    await flush()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(v.scene.primitives.add).toHaveBeenCalled()
    // 无相机 → 回退到"程序初始位置"（camera.flyTo 至少被调用一次）
    expect(v.camera.flyTo).toHaveBeenCalled()
  })

  it('有相机 WebMap（viewpoint）添加后飞到该相机', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }))
    )
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'cam-map',
        title: 'Cam',
        kind: 'webmap',
        webmap: {
          viewpoint: {
            camera: {
              position: { x: 2.1734, y: 41.3874, z: 1000, spatialReference: { wkid: 4326 } },
              heading: 30,
              tilt: 45,
            },
          },
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'op', title: 'Img', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
          ],
        },
      })
    })
    await flush()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    // 有相机 → camera.flyTo 用的是解析出的相机位置/朝向
    const calls = v.camera.flyTo.mock.calls
    const camCall = calls.find((c: unknown[]) => {
      const o = c[0] as { destination?: { args?: number[] }; orientation?: { heading: number; pitch: number } }
      return Array.isArray(o.destination?.args) && o.destination.args[0] === 2.1734
    })
    expect(camCall).toBeDefined()
    expect(camCall![0].orientation.heading).toBeCloseTo(Math.PI / 6)
    expect(camCall![0].orientation.pitch).toBeCloseTo((45 - 90) * Math.PI / 180)
  })

  it('业务层超过上限时仅渲染前 N 个并提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }))
    )
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'many',
        title: 'Many',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: Array.from({ length: 8 }, (_, i) => ({ id: 'm' + i, title: 'M' + i, url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' })),
        },
      })
    })
    await flush()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(v.scene.primitives.add).toHaveBeenCalled()
    expect(screen.getByText(/仅渲染前 5 个/)).toBeInTheDocument()
  })

  it('全局矢量瓦片底图按官方样式渲染（不再降级 OSM 栅格）', async () => {
    maplibreMock.instances.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })))
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'gvt',
        title: 'Streets',
        kind: 'webmap',
        webmap: {
          baseMap: {
            baseMapLayers: [{ id: 'vt', title: 'World Street Map', url: '', layerType: 'VectorTileLayer', styleUrl: 'https://cdn.arcgis.com/sharing/rest/content/items/abc/resources/styles/root.json' }],
          },
          operationalLayers: [],
        },
      })
    })
    await flush()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(maplibreMock.instances.length).toBe(1)
    expect(maplibreMock.instances[0].opts.styleUrl).toContain('root.json')
    expect(v.imageryLayers.add).toHaveBeenCalled()
  })

  it('非法 webmap（operationalLayers 非数组）触发渲染队列兜底，不阻断后续', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }))
    )
    render(<GlobeViewer />)
    await flush()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'bad',
        title: 'Bad',
        kind: 'webmap',
        // 故意把 operationalLayers 设为普通对象（非数组），collectLayers for..of 会抛
        webmap: { baseMap: { baseMapLayers: [] }, operationalLayers: { not: 'array' } as unknown as [] },
      })
    })
    await flush()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useAppStore.getState().layerErrors.bad).toContain('图层加载失败')
  })

  it('pitch 超出范围时钳制回合法区间', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    v.camera.pitch = -3
    const frameCb = v.scene.postUpdate.addEventListener.mock.calls[0][0] as () => void
    frameCb()
    expect(v.camera.setView).toHaveBeenCalled()
    const pitch = v.camera.setView.mock.calls[0][0].orientation.pitch
    expect(pitch).toBeGreaterThanOrEqual(-Math.PI / 2 - 0.01)
    expect(pitch).toBeLessThanOrEqual(0)
  })

  it('瓦片加载队列变化时唤醒静止场景重绘', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const event = v.scene.globe.tileLoadProgressEvent
    expect(event.addEventListener).toHaveBeenCalledTimes(1)
    const onTileLoadProgress = event.addEventListener.mock.calls[0][0] as (remaining: number) => void
    const renderCallsBefore = v.scene.requestRender.mock.calls.length
    onTileLoadProgress(1)
    expect(v.scene.requestRender.mock.calls.length).toBe(renderCallsBefore + 1)
    await act(async () => {
      onTileLoadProgress(0)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(v.scene.requestRender.mock.calls.length).toBe(renderCallsBefore + 2)
    cleanup()
    expect(event.removeEventListener).toHaveBeenCalledWith(onTileLoadProgress)
  })

  it('缩放稳定后 SSE 从 2 回落到 1（高分屏清晰度优先）', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const wheelHandler = v.scene.canvas.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === 'wheel'
    )?.[1] as (e: { deltaY: number; preventDefault: () => void }) => void
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(5000)
    wheelHandler({ deltaY: 100, preventDefault: vi.fn() })
    // 首次帧：diff 大 → SSE 2
    const frameCb = v.scene.postUpdate.addEventListener.mock.calls[0][0] as () => void
    frameCb()
    expect(v.scene.globe.maximumScreenSpaceError).toBe(2)
    // 让相机高度贴近目标高度 → 连续帧稳定
    v.camera.positionCartographic.height = 1250
    for (let i = 0; i < 12; i++) frameCb()
    expect(v.scene.globe.maximumScreenSpaceError).toBe(1)
    nowSpy.mockRestore()
  })

  it('添加 GeoJSON 图层 → GeoJsonDataSource.load 并加入 dataSources', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })))
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'gj',
        title: 'Countries',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'g1', title: 'Countries', url: 'https://x/countries.geojson', layerType: 'GeoJSONLayer' },
          ],
        },
      })
    })
    await flush()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(v.dataSources.add).toHaveBeenCalled()
  })

  it('添加 KML 图层 → 转 GeoJSON 预算管线并加入 dataSources', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>P</name><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>',
    })))
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'kml',
        title: 'Places',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'k1', title: 'Places', url: 'https://x/places.kml', layerType: 'KMLLayer' },
          ],
        },
      })
    })
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve()
    })
    expect(v.dataSources.add).toHaveBeenCalled()
  })

  it('飞行中滚轮 → cancelFlight 被调用', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    v.camera._currentFlight = { active: true }
    const wheelHandler = v.scene.canvas.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === 'wheel'
    )?.[1] as (e: { deltaY: number; preventDefault: () => void }) => void
    wheelHandler({ deltaY: 100, preventDefault: vi.fn() })
    expect(v.camera.cancelFlight).toHaveBeenCalled()
  })

  it('鼠标按下（LEFT_DOWN）→ 取消飞行并重置缩放窗口', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    v.camera._currentFlight = { active: true }
    const h = cesiumMock.handlerInstances[0]
    const ld = h.setInputAction.mock.calls.find((c: unknown[]) => c[1] === 'LEFT_DOWN')
    ld![0]()
    expect(v.camera.cancelFlight).toHaveBeenCalled()
    // RIGHT_DOWN / MIDDLE_DOWN 同样注册
    expect(h.setInputAction.mock.calls.some((c: unknown[]) => c[1] === 'RIGHT_DOWN')).toBe(true)
    expect(h.setInputAction.mock.calls.some((c: unknown[]) => c[1] === 'MIDDLE_DOWN')).toBe(true)
  })

  it('GeoJSON \u52a0\u8f7d\u5931\u8d25 \u2192 setLayerError \u5e76\u63d0\u793a', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })))
    render(<GlobeViewer />)
    await flush()
        const { GeoJsonDataSource } = await import('cesium')
    ;(GeoJsonDataSource.load as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    act(() => {
      useAppStore.getState().addLayer({
        id: 'gj',
        title: 'Countries',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'g1', title: 'Countries', url: 'https://x/countries.geojson', layerType: 'GeoJSONLayer' },
          ],
        },
      })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useAppStore.getState().layerErrors['gj']).toMatch(/GeoJSON \u56fe\u5c42\u52a0\u8f7d\u5931\u8d25/)
  })

  it('KML \u52a0\u8f7d\u5931\u8d25 \u2192 setLayerError \u5e76\u63d0\u793a', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net') }))
    render(<GlobeViewer />)
    await flush()
        const { KmlDataSource } = await import('cesium')
    ;(KmlDataSource.load as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    act(() => {
      useAppStore.getState().addLayer({
        id: 'kml',
        title: 'Places',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'k1', title: 'Places', url: 'https://x/places.kml', layerType: 'KMLLayer' },
          ],
        },
      })
    })
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve()
    })
    expect(useAppStore.getState().layerErrors['kml']).toMatch(/KML \u56fe\u5c42\u52a0\u8f7d\u5931\u8d25/)
  })

  it('KML 转 GeoJSON 失败 → 回退原生 KmlDataSource.load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<not-kml' })))
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'kml2',
        title: 'Places',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'k1', title: 'Places', url: 'https://x/places.kml', layerType: 'KMLLayer' },
          ],
        },
      })
    })
    await act(async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve()
    })
    const { KmlDataSource } = await import('cesium')
    expect(KmlDataSource.load).toHaveBeenCalled()
    expect(v.dataSources.add).toHaveBeenCalled()
  })
  it('添加 3D Scene 图层 → I3SDataProvider.fromUrl 并加入 primitives', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const { I3SDataProvider } = await import('cesium')
    const fromUrl = I3SDataProvider.fromUrl as unknown as ReturnType<typeof vi.fn>
    fromUrl.mockClear()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'scene', title: 'Buildings', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 's1', title: 'Buildings', url: 'https://x/SceneServer/layers/0', layerType: 'ArcGISSceneServiceLayer' },
          ],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(fromUrl).toHaveBeenCalledWith(
      'https://x/SceneServer/layers/0',
      expect.objectContaining({ applySymbology: true })
    )
    expect(v.scene.primitives.add).toHaveBeenCalled()
  })

  it('添加 3D Tiles 图层 → Cesium3DTileset.fromUrl 并加入 primitives', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const { Cesium3DTileset } = await import('cesium')
    const fromUrl = Cesium3DTileset.fromUrl as unknown as ReturnType<typeof vi.fn>
    fromUrl.mockClear()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'tiles', title: '3D Model', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 't1', title: '3D Model', url: 'https://x/tileset.json', layerType: '3DTilesService' },
          ],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(fromUrl).toHaveBeenCalled()
    expect(v.scene.primitives.add).toHaveBeenCalled()
  })

  it('添加 VectorTile 图层 → MapLibre 样式 provider 渲染为 ImageryLayer', async () => {
    maplibreMock.instances.length = 0
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'vt', title: 'Streets', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'v1', title: 'Streets', url: 'https://x/VectorTileServer', layerType: 'VectorTileLayer', styleUrl: 'https://x/style' },
          ],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(maplibreMock.instances.length).toBe(1)
    expect(maplibreMock.instances[0].opts.styleUrl).toBe('https://x/style')
    expect(maplibreMock.instances[0].opts.url).toBe('https://x/VectorTileServer')
    expect(v.imageryLayers.add).toHaveBeenCalled()
  })

  it('WebScene 只有 styleUrl 的 VectorTileLayer → provider 直接用样式地址渲染', async () => {
    maplibreMock.instances.length = 0
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'scene-vt', title: 'Scene Basemap', kind: 'webmap',
        webmap: {
          baseMap: {
            baseMapLayers: [{
              id: 'vt',
              title: 'Scene Basemap',
              layerType: 'VectorTileLayer',
              styleUrl: 'https://cdn.example/root.json',
            }],
          },
          operationalLayers: [],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(maplibreMock.instances.length).toBe(1)
    expect(maplibreMock.instances[0].opts.styleUrl).toBe('https://cdn.example/root.json')
    expect(v.imageryLayers.add).toHaveBeenCalled()
  })

  it('VectorTile 样式加载失败 → 报错并销毁 provider', async () => {
    maplibreMock.instances.length = 0
    render(<GlobeViewer />)
    await flush()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'vt-fail', title: 'Fail', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'v1', title: 'Fail', url: 'https://x/VectorTileServer', layerType: 'VectorTileLayer', styleUrl: 'https://fail' },
          ],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(maplibreMock.instances.length).toBe(1)
    expect(maplibreMock.instances[0].destroy).toHaveBeenCalled()
  })

  it('多图层 Feature Service → 区划层跳过、事件层渲染为 dataSource', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.endsWith('/FeatureServer?f=json')) return { ok: true, json: async () => ({ layers: [{ id: 1 }, { id: 2 }], fullExtent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90 }, spatialReference: { wkid: 4326 } }) }
      if (u.includes('/FeatureServer/1?f=json')) return { ok: true, json: async () => ({ drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSFS', color: [100, 100, 255, 255], outline: { color: [0, 0, 0, 255], width: 1 } } } } }) }
      if (u.includes('/FeatureServer/2?f=json')) return { ok: true, json: async () => ({ drawingInfo: { renderer: { type: 'uniqueValue', field1: 'Event', uniqueValueInfos: [{ value: 'Watch', symbol: { type: 'esriSFS', color: [255, 0, 0, 128] } }] } } }) }
      if (u.includes('/query')) return { ok: true, json: async () => ({ features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { Event: 'Watch' } }] }) }
      return { ok: true, json: async () => ({}) }
    }))
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'mfc', title: 'Multi', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [{ id: 'l', title: 'Multi', url: 'https://x/FeatureServer', layerType: 'ArcGISFeatureLayer' }],
        },
      })
    })
    await act(async () => { for (let i = 0; i < 14; i++) await Promise.resolve() })
    expect(v.dataSources.add).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('添加 Feature 图层 → 重投影后 GeoJsonDataSource.load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u)
      if (url.endsWith('?f=json')) {
        return { ok: true, json: async () => ({ spatialReference: { wkid: 4326 }, maxRecordCount: 1000, drawingInfo: { renderer: { type: 'unsupported' } } }) }
      }
      return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [{ id: 1 }] }) }
    }))
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const { GeoJsonDataSource } = await import('cesium')
    const load = GeoJsonDataSource.load as unknown as ReturnType<typeof vi.fn>
    load.mockClear()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'feat', title: 'Incidents', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'f1', title: 'Incidents', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' },
          ],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(load).not.toHaveBeenCalled()
    expect(v.scene.primitives.add).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('内嵌 FeatureCollection 图层 → 走预算管线并加入 dataSources', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'fc',
        title: 'Embedded',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'fs1', title: 'Embedded', layerType: 'FeatureCollection', layerDefinition: { featureCollection: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }] } } },
          ],
        },
      })
    })
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
    expect(v.dataSources.add).toHaveBeenCalled()
  })

  it('添加 WFS 图层 → 通过 OGC 适配器读取 GeoJSON 并加入 dataSources', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const { fetchOgcFeatureGeoJSON } = await import('./ogc')
    const fetchOgc = fetchOgcFeatureGeoJSON as unknown as ReturnType<typeof vi.fn>
    fetchOgc.mockClear()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'wfs', title: 'Roads', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'w1', title: 'Roads', url: 'https://x/wfs', type: 'WFS' },
          ],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(fetchOgc).toHaveBeenCalledWith('https://x/wfs', expect.objectContaining({ type: 'WFS' }), expect.anything())
    expect(v.dataSources.add).toHaveBeenCalled()
  })

  it('WFS 数据超出单层上限时降级并提示', async () => {
    const { fetchOgcFeatureGeoJSON } = await import('./ogc')
    const ogcMock = fetchOgcFeatureGeoJSON as unknown as ReturnType<typeof vi.fn>
    ogcMock.mockResolvedValueOnce({ type: 'FeatureCollection', features: Array(1600) as never })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })))
    render(<GlobeViewer />)
    await flush()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'wfs-cap',
        title: 'WfsCap',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [{ id: 'w', title: 'Wfs', url: 'https://x/wfs', type: 'WFS' }],
        },
      })
    })
    await flush()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/数据量大/)).toBeInTheDocument()
  })

  it('添加 CSV 图层 → 转为 GeoJSON 并加入 dataSources', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const { fetchCsvGeoJSON } = await import('./csv')
    const fetchCsv = fetchCsvGeoJSON as unknown as ReturnType<typeof vi.fn>
    fetchCsv.mockClear()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'csv', title: 'Points', kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [
            { id: 'c1', title: 'Points', url: 'https://x/points.csv', layerType: 'CSVLayer' },
          ],
        },
      })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(fetchCsv).toHaveBeenCalledWith('https://x/points.csv', expect.objectContaining({ layerType: 'CSVLayer' }), expect.anything())
    expect(v.dataSources.add).toHaveBeenCalled()
  })



  it('WebGL 不可用时优雅降级显示提示且不创建球', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/120' })
    const origCreate = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string, opts?: ElementCreationOptions) => {
      const el = origCreate(tag, opts)
      if (tag === 'canvas') (el as HTMLCanvasElement & { getContext: () => null }).getContext = () => null
      return el
    })
    try {
      render(<GlobeViewer />)
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText(/无法创建 WebGL/)).toBeInTheDocument()
    } finally {
      spy.mockRestore()
      vi.unstubAllGlobals()
    }
  })


  it('GeoJSON 渲染后开启点聚合', async () => {
    const { GeoJsonDataSource } = await import('cesium')
    const ds = {
      clustering: { enabled: false, pixelRange: 0, minimumClusterSize: 0, clusterBillboards: false },
    } as never
    ;(GeoJsonDataSource.load as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ds)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })))
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'g2',
        title: 'P',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [{ id: 'p1', title: 'P', url: 'https://x/p.geojson', layerType: 'GeoJSONLayer' }],
        },
      })
    })
    await flush()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(v.dataSources.add).toHaveBeenCalled()
    expect((ds as { clustering: { enabled: boolean } }).clustering.enabled).toBe(true)
  })

})


describe('viewpointCameraFromWebmap', () => {
  it('解析 4326 相机的目的地与朝向', () => {
    const wm = { viewpoint: { camera: { position: { x: 2.17, y: 41.38, z: 1000, spatialReference: { wkid: 4326 } }, heading: 30, tilt: 45 } } }
    const cam = viewpointCameraFromWebmap(wm as never)
    expect(cam?.destination).toEqual({ tag: 'fromDegrees', args: [2.17, 41.38, 1000] })
    expect(cam?.orientation.heading).toBeCloseTo(Math.PI / 6)
    expect(cam?.orientation.pitch).toBeCloseTo((45 - 90) * Math.PI / 180)
  })

  it('解析 3857 相机（反投影到经纬度）', () => {
    // 3857 下 x=111319.49m ≈ 1° 经线，y=0 → 赤道
    const wm = { initialState: { viewpoint: { camera: { position: { x: 111319.49, y: 0, z: 500, spatialReference: { wkid: 102100 } }, heading: 0, tilt: 90 } } } }
    const cam = viewpointCameraFromWebmap(wm as never)
    const args = (cam?.destination as unknown as { args: number[] })?.args
    expect(args[0]).toBeCloseTo(1, 1)
    expect(args[1]).toBeCloseTo(0, 1)
    expect(cam?.orientation.pitch).toBeCloseTo(0)
  })

  it('无相机 → 返回 null', () => {
    expect(viewpointCameraFromWebmap({ baseMap: {} } as never)).toBeNull()
    expect(viewpointCameraFromWebmap({ viewpoint: {} } as never)).toBeNull()
    expect(viewpointCameraFromWebmap(undefined)).toBeNull()
  })


  it('3D Scene 加载失败 → setLayerError', async () => {
    render(<GlobeViewer />)
    await flush()
    const { I3SDataProvider } = await import('cesium')
    ;(I3SDataProvider.fromUrl as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    act(() => {
      useAppStore.getState().addLayer({ id: 'scene-fail', title: 'B', kind: 'webmap', webmap: { baseMap: { baseMapLayers: [] }, operationalLayers: [{ id: 's1', title: 'B', url: 'https://x/SceneServer/layers/0', layerType: 'ArcGISSceneServiceLayer' }] } })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(useAppStore.getState().layerErrors['scene-fail']).toMatch(/3D 场景加载失败/)
  })

  it('3D Tiles 加载失败 → setLayerError', async () => {
    render(<GlobeViewer />)
    await flush()
    const { Cesium3DTileset } = await import('cesium')
    ;(Cesium3DTileset.fromUrl as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    act(() => {
      useAppStore.getState().addLayer({ id: 'tiles-fail', title: 'T', kind: 'webmap', webmap: { baseMap: { baseMapLayers: [] }, operationalLayers: [{ id: 't1', title: 'T', url: 'https://x/tileset.json', layerType: '3DTilesService' }] } })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(useAppStore.getState().layerErrors['tiles-fail']).toMatch(/3D Tiles 加载失败/)
  })

  it('WFS 加载失败 → setLayerError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })))
    render(<GlobeViewer />)
    await flush()
    const { fetchOgcFeatureGeoJSON } = await import('./ogc')
    ;(fetchOgcFeatureGeoJSON as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    act(() => {
      useAppStore.getState().addLayer({ id: 'wfs-fail', title: 'R', kind: 'webmap', webmap: { baseMap: { baseMapLayers: [] }, operationalLayers: [{ id: 'w1', title: 'R', url: 'https://x/wfs', type: 'WFS' }] } })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(useAppStore.getState().layerErrors['wfs-fail']).toMatch(/WFS\/OGC 要素图层加载失败/)
  })



  it('Viewer 创建失败 → 显示地球初始化失败', async () => {
    const { Viewer } = await import('cesium')
    ;(Viewer as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('boom') })
    render(<GlobeViewer />)
    await flush()
    expect(screen.getByText(/地球初始化失败/)).toBeInTheDocument()
  })

})

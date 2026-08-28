import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CesiumFacade,
  __resetTerrainCacheForTest,
  isWebglAvailable,
} from './CesiumFacade'
import type { LayerRuntime } from '../domain/runtime'
import { flyToHome } from '../globe/facade/cameraApi'

// ---- Cesium mock（fake Viewer，记录创建参数/图层/地形） ----
const cesiumMock = vi.hoisted(() => {
  const viewers: any[] = []
  const viewerOptions: any[] = []
  const imageryLayerInstances: any[] = []
  const terrainProviders: any[] = []
  const inputHandlers: any[] = []
  let failNextCreate = false

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
    const canvas = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const globe = {
      baseColor: undefined,
      maximumScreenSpaceError: 0,
      tileCacheSize: 0,
      preloadSiblings: false,
      tileLoadProgressEvent: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      getHeight: vi.fn(() => undefined),
      showGroundAtmosphere: true,
      enableLighting: false,
      ellipsoid: {
        cartesianToCartographic: vi.fn(() => ({ longitude: 0.5, latitude: 0.25 })),
      },
      translucency: { enabled: false, frontFaceAlpha: 1, backFaceAlpha: 1 },
    }
    const scene = {
      canvas,
      globe,
      screenSpaceCameraController: {},
      postProcessStages: { bloom: { enabled: true } },
      requestRender: vi.fn(),
      primitives: { add: vi.fn(), remove: vi.fn() },
      postUpdate: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      skyBox: { show: true },
      sun: { show: true },
      moon: { show: true },
      fog: { enabled: false },
      verticalExaggeration: 1,
      backgroundColor: undefined,
    }
    const camera = {
      positionCartographic: { height: 20000000, longitude: 1, latitude: 0.5 },
      heading: 0.1,
      pitch: -0.2,
      roll: 0,
      position: { tag: 'pos' },
      flyTo: vi.fn(),
      cancelFlight: vi.fn(),
      moveForward: vi.fn(),
      setView: vi.fn(),
      pickEllipsoid: vi.fn(() => ({ hit: true })),
      computeViewRectangle: vi.fn(() => ({ west: 0, south: 0, east: 1, north: 1 })),
      moveEnd: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    }
    ;(scene as { camera?: unknown }).camera = camera
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

  return {
    viewers,
    viewerOptions,
    imageryLayerInstances,
    terrainProviders,
    inputHandlers,
    makeViewer,
    get failNextCreate() {
      return failNextCreate
    },
    set failNextCreate(v: boolean) {
      failNextCreate = v
    },
  }
})

vi.mock('cesium', () => {
  const CM = cesiumMock
  return {
    Viewer: vi.fn(function (_container: unknown, options: unknown) {
      if (CM.failNextCreate) {
        CM.failNextCreate = false
        throw new Error('webgl init fail')
      }
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
    Cartesian3: {
      fromRadians: vi.fn((lon: number, lat: number, height: number) => ({ cart: 'rad', lon, lat, height })),
      fromDegrees: vi.fn((lon: number, lat: number, height: number) => ({ cart: 'deg', lon, lat, height })),
    },
    CameraEventType: { RIGHT_DRAG: 'RIGHT_DRAG', PINCH: 'PINCH' },
    ScreenSpaceEventHandler: vi.fn(function (canvas: unknown) {
      const h = { canvas, setInputAction: vi.fn(), destroy: vi.fn() }
      CM.inputHandlers.push(h)
      return h
    }),
    ScreenSpaceEventType: {
      LEFT_DOWN: 'LEFT_DOWN',
      RIGHT_DOWN: 'RIGHT_DOWN',
      MIDDLE_DOWN: 'MIDDLE_DOWN',
      LEFT_DOUBLE_CLICK: 'LEFT_DOUBLE_CLICK',
    },
    UrlTemplateImageryProvider: vi.fn(function (opts: unknown) {
      return { provider: 'urlTemplate', opts }
    }),
    GeographicTilingScheme: vi.fn(function () {
      return { scheme: 'geo' }
    }),
    ImageryLayer: vi.fn(function (provider: unknown) {
      const inst = { provider, alpha: 1 }
      CM.imageryLayerInstances.push(inst)
      return inst
    }),
    ArcGISTiledElevationTerrainProvider: {
      fromUrl: vi.fn(() => {
        const p = { terrain: 't' }
        CM.terrainProviders.push(p)
        return Promise.resolve(p)
      }),
    },
    GeoJsonDataSource: {
      load: vi.fn((data: unknown) =>
        Promise.resolve({
          clustering: { enabled: false, pixelRange: 0, minimumClusterSize: 0, clusterBillboards: false },
          loaded: data,
        })
      ),
    },
    KmlDataSource: {
      load: vi.fn((url: unknown) => Promise.resolve({ kml: url })),
    },
    Rectangle: {
      fromDegrees: vi.fn((w: number, s: number, e: number, n: number) => ({ rect: [w, s, e, n] })),
    },
  }
})

// MapLibre 矢量瓦片 provider：mock 掉真实 MapLibre，ready 由构造后微任务决定
const maplibreMock = vi.hoisted(() => {
  const instances: Array<{
    opts: Record<string, unknown>
    readyPromise: Promise<void>
    destroy: ReturnType<typeof vi.fn>
  }> = []
  let failNext = false
  return {
    instances,
    get failNext() {
      return failNext
    },
    set failNext(v: boolean) {
      failNext = v
    },
  }
})

vi.mock('../globe/facade/maplibreImagery', () => {
  class MockVectorProvider {
    readyPromise: Promise<void>
    destroy = vi.fn()
    constructor(public opts: Record<string, unknown>) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        queueMicrotask(() => {
          if (opts.styleUrl === 'https://fail' || maplibreMock.failNext) reject(new Error('style fail'))
          else resolve()
        })
      })
      maplibreMock.instances.push(this as never)
    }
  }
  return {
    ArcGisVectorTileImageryProvider: MockVectorProvider,
    normalizeArcGisStyle: vi.fn((st: unknown) => st),
    tileCenterLngLat: vi.fn((x: number, y: number) => ({ lng: x, lat: y })),
  }
})

vi.mock('../globe/facade/webmap', () => ({
  providerForWebLayer: vi.fn(async (op: { fail?: boolean }) => (op.fail ? null : { provider: 'web' })),
  WORLD_IMAGERY_WGS84_TILES: 'https://imagery.example/{z}/{y}/{x}',
  WORLD_VECTOR_LABELS_STYLE_URL: 'https://labels.example/style.json',
}))

vi.mock('../globe/facade/scene', () => ({
  loadI3S: vi.fn(async (url: string) => ({ prim: 'i3s-' + url })),
  load3DTiles: vi.fn(async (url: string) => ({ tileset: '3d-' + url })),
}))

vi.mock('../globe/facade/cameraApi', () => ({
  registerViewer: vi.fn(),
  unregisterViewer: vi.fn(),
  flyToHome: vi.fn(),
}))

const viewportMock = vi.hoisted(() => {
  const controllers: Array<{ update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = []
  return { controllers }
})

vi.mock('../globe/viewport/viewportController', () => ({
  createViewportController: vi.fn(() => {
    const ctl = { update: vi.fn(async () => {}), dispose: vi.fn() }
    viewportMock.controllers.push(ctl)
    return ctl
  }),
}))

function viewer() {
  return cesiumMock.viewers[cesiumMock.viewers.length - 1]
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function freshRuntime(): LayerRuntime {
  return {
    imagery: [],
    dataSources: [],
    primitives: [],
    vectorProviders: [],
    dispose: vi.fn(),
  }
}

function makeFacade() {
  const facade = new CesiumFacade()
  const el = document.createElement('div')
  const ok = facade.create(el)
  return { facade, v: viewer(), ok }
}

describe('CesiumFacade（W3.4）', () => {
  beforeEach(() => {
    cesiumMock.viewers.length = 0
    cesiumMock.viewerOptions.length = 0
    cesiumMock.imageryLayerInstances.length = 0
    cesiumMock.terrainProviders.length = 0
    cesiumMock.inputHandlers.length = 0
    cesiumMock.failNextCreate = false
    viewportMock.controllers.length = 0
    maplibreMock.instances.length = 0
    maplibreMock.failNext = false
    __resetTerrainCacheForTest()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('create / 生命周期', () => {
    it('创建 Viewer 并配置 requestRenderMode 与高 DPI 渲染', () => {
      const { ok, v } = makeFacade()
      expect(ok).toBe(true)
      const opts = cesiumMock.viewerOptions[0]
      expect(opts.requestRenderMode).toBe(true)
      expect(opts.useBrowserRecommendedResolution).toBe(false)
      expect(opts.baseLayer).toBe(false)
      expect(v.scene.postProcessStages.bloom.enabled).toBe(false)
      expect(v.scene.globe.baseColor).toEqual({ css: '#0d1526' })
      expect(v.scene.globe.tileCacheSize).toBe(100)
      expect(v.scene.globe.preloadSiblings).toBe(false)
      expect(v.scene.screenSpaceCameraController.tiltEventTypes).toBe('RIGHT_DRAG')
      expect(v.scene.screenSpaceCameraController.zoomEventTypes).toEqual(['PINCH'])
      expect((window as unknown as { __evViewer: unknown }).__evViewer).toBe(v)
    })

    it('注册 WebGL 上下文丢失/恢复与瓦片加载进度监听', () => {
      const { v } = makeFacade()
      const canvasCalls = v.scene.canvas.addEventListener.mock.calls.map((c: unknown[]) => c[0])
      expect(canvasCalls).toContain('webglcontextlost')
      expect(canvasCalls).toContain('webglcontextrestored')
      expect(v.scene.globe.tileLoadProgressEvent.addEventListener).toHaveBeenCalledTimes(1)
    })

    it('瓦片加载完成后延迟补渲染一帧，避免最后一帧被 requestRenderMode 吞掉', () => {
      const { v } = makeFacade()
      const onProgress = v.scene.globe.tileLoadProgressEvent.addEventListener.mock.calls[0][0]
      onProgress(3)
      expect(v.scene.requestRender).toHaveBeenCalledTimes(1)
      onProgress(0)
      return new Promise((resolve) => {
        setTimeout(() => {
          expect(v.scene.requestRender).toHaveBeenCalledTimes(2)
          resolve(null)
        }, 5)
      })
    })

    it('初始化失败时调用 onInitError 并返回 false', () => {
      const facade = new CesiumFacade()
      const onInitError = vi.fn()
      cesiumMock.failNextCreate = true
      const ok = facade.create(document.createElement('div'), { onInitError })
      expect(ok).toBe(false)
      expect(onInitError).toHaveBeenCalledWith(expect.stringContaining('地球初始化失败'))
      expect(facade.viewer).toBeNull()
    })

    it('destroy 注销 cameraApi 并销毁 Viewer', () => {
      const { facade, v } = makeFacade()
      facade.destroy()
      expect(v.destroy).toHaveBeenCalledTimes(1)
      expect(facade.viewer).toBeNull()
    })

    it('requestFrame / setScreenSpaceError 在 viewer 销毁后安全跳过', () => {
      const { facade, v } = makeFacade()
      v.isDestroyed.mockReturnValue(true)
      expect(() => facade.requestFrame()).not.toThrow()
      expect(() => facade.setScreenSpaceError(0.5)).not.toThrow()
      expect(() => facade.flyTo({})).not.toThrow()
      expect(() => facade.viewEnvelope()).not.toThrow()
    })
  })

  describe('渲染唤醒 / 地形 / 相机', () => {
    it('requestFrame 只在 viewer 存活时触发', () => {
      const { facade, v } = makeFacade()
      facade.requestFrame()
      expect(v.scene.requestRender).toHaveBeenCalledTimes(1)
      v.isDestroyed.mockReturnValue(true)
      facade.requestFrame()
      expect(v.scene.requestRender).toHaveBeenCalledTimes(1)
    })

    it('setScreenSpaceError 只在值变化时写入', () => {
      const { facade, v } = makeFacade()
      facade.setScreenSpaceError(1)
      facade.setScreenSpaceError(1)
      expect(v.scene.globe.maximumScreenSpaceError).toBe(1)
      facade.setScreenSpaceError(2)
      expect(v.scene.globe.maximumScreenSpaceError).toBe(2)
    })

    it('getTerrainProvider 缓存 Provider，只请求一次', async () => {
      const facade = new CesiumFacade()
      const p1 = await facade.getTerrainProvider()
      const p2 = await facade.getTerrainProvider()
      expect(p1).toBe(p2)
      expect(cesiumMock.terrainProviders.length).toBe(1)
    })

    it('applyTerrain 挂载地形并补渲染', async () => {
      const { facade, v } = makeFacade()
      await facade.applyTerrain()
      expect(v.terrainProvider).toBe(cesiumMock.terrainProviders[0])
      expect(v.scene.requestRender).toHaveBeenCalled()
    })

    it('flyTo / flyToExtent 委托 camera.flyTo 并补渲染', () => {
      const { facade, v } = makeFacade()
      facade.flyTo({ dest: 1 }, { heading: 0, pitch: -1.5, roll: 0 })
      expect(v.camera.flyTo).toHaveBeenCalledWith({
        destination: { dest: 1 },
        orientation: { heading: 0, pitch: -1.5, roll: 0 },
      })
      facade.flyToExtent({ west: -10, south: -5, east: 10, north: 5 })
      expect(v.camera.flyTo).toHaveBeenLastCalledWith({
        destination: { rect: [-10, -5, 10, 5] },
      })
      expect(v.scene.requestRender).toHaveBeenCalled()
    })

    it('viewEnvelope 把弧度矩形换算为经纬度', () => {
      const { facade, v } = makeFacade()
      const env = facade.viewEnvelope()
      expect(env).not.toBeNull()
      expect(env!.west).toBeCloseTo(0)
      expect(env!.east).toBeCloseTo(57.2958, 2)
      expect(v.camera.computeViewRectangle).toHaveBeenCalled()
    })

    it('flyToHome 委托 cameraApi', () => {
      const { facade, v } = makeFacade()
      facade.flyToHome()
      expect(vi.mocked(flyToHome)).toHaveBeenCalledWith(v)
    })
  })

  describe('相机表面 / 效果表面（W3.2/W3.3）', () => {
    it('cameraPosition / cameraOrientation / groundHeight 读取当前值', () => {
      const { facade, v } = makeFacade()
      expect(facade.cameraPosition()).toEqual({ longitude: 1, latitude: 0.5, height: 20000000 })
      expect(facade.cameraOrientation()).toEqual({ heading: 0.1, pitch: -0.2, roll: 0 })
      v.scene.globe.getHeight.mockReturnValue(300)
      expect(facade.groundHeight()).toBe(300)
      v.isDestroyed.mockReturnValue(true)
      expect(facade.cameraPosition()).toEqual({ longitude: 0, latitude: 0, height: 0 })
      expect(facade.cameraOrientation()).toEqual({ heading: 0, pitch: 0, roll: 0 })
      expect(facade.groundHeight()).toBeUndefined()
    })

    it('isFlying / cancelFlight 基于 _currentFlight', () => {
      const { facade, v } = makeFacade()
      expect(facade.isFlying()).toBe(false)
      ;(v.camera as { _currentFlight?: unknown })._currentFlight = { tag: 'flight' }
      expect(facade.isFlying()).toBe(true)
      facade.cancelFlight()
      expect(v.camera.cancelFlight).toHaveBeenCalledTimes(1)
      delete (v.camera as { _currentFlight?: unknown })._currentFlight
      facade.cancelFlight()
      expect(v.camera.cancelFlight).toHaveBeenCalledTimes(1)
    })

    it('moveForward / setView / flyToLonLat 委托相机并补渲染', () => {
      const { facade, v } = makeFacade()
      facade.moveForward(120)
      expect(v.camera.moveForward).toHaveBeenCalledWith(120)
      facade.setView({ longitude: 1.2, latitude: 0.4, height: 5000 }, { heading: 0, pitch: -0.5, roll: 0 })
      expect(v.camera.setView).toHaveBeenCalledWith({
        destination: { cart: 'rad', lon: 1.2, lat: 0.4, height: 5000 },
        orientation: { heading: 0, pitch: -0.5, roll: 0 },
      })
      facade.flyToLonLat(30, 40, 8000, { heading: 0, pitch: -0.5, roll: 0 })
      expect(v.camera.flyTo).toHaveBeenCalledWith({
        destination: { cart: 'deg', lon: 30, lat: 40, height: 8000 },
        orientation: { heading: 0, pitch: -0.5, roll: 0 },
      })
      expect(v.scene.requestRender).toHaveBeenCalled()
    })

    it('pickLonLat 命中返回经纬度（度），未命中返回 null', () => {
      const { facade, v } = makeFacade()
      const ellipsoid = v.scene.globe.ellipsoid
      const picked = facade.pickLonLat(10, 20)
      expect(picked).not.toBeNull()
      expect(picked!.lon).toBeCloseTo((0.5 * 180) / Math.PI)
      expect(picked!.lat).toBeCloseTo((0.25 * 180) / Math.PI)
      expect(v.camera.pickEllipsoid).toHaveBeenCalledWith({ x: 10, y: 20 }, ellipsoid)
      v.camera.pickEllipsoid.mockReturnValueOnce(null)
      expect(facade.pickLonLat(10, 20)).toBeNull()
    })

    it('onWheel 注册/注销 canvas wheel 监听（passive:false）', () => {
      const { facade, v } = makeFacade()
      const cb = vi.fn()
      const off = facade.onWheel(cb)
      expect(v.scene.canvas.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), {
        passive: false,
      })
      const handler = v.scene.canvas.addEventListener.mock.calls.find((c: unknown[]) => c[0] === 'wheel')![1]
      handler({ deltaY: 5 })
      expect(cb).toHaveBeenCalledWith({ deltaY: 5 })
      off()
      expect(v.scene.canvas.removeEventListener).toHaveBeenCalledWith('wheel', handler)
    })

    it('onPointerDown 共享 handler 注册三键，注销到 0 引用时销毁', () => {
      const { facade, v } = makeFacade()
      const off1 = facade.onPointerDown(vi.fn())
      const off2 = facade.onPointerDown(vi.fn())
      expect(cesiumMock.inputHandlers.length).toBe(1)
      const h = cesiumMock.inputHandlers[0]
      expect(h.canvas).toBe(v.scene.canvas)
      expect(h.setInputAction).toHaveBeenCalledWith(expect.any(Function), 'LEFT_DOWN')
      expect(h.setInputAction).toHaveBeenCalledWith(expect.any(Function), 'RIGHT_DOWN')
      expect(h.setInputAction).toHaveBeenCalledWith(expect.any(Function), 'MIDDLE_DOWN')
      off1()
      expect(h.destroy).not.toHaveBeenCalled()
      off2()
      expect(h.destroy).toHaveBeenCalledTimes(1)
    })

    it('onDoubleClick 拾取后回调经纬度（度），未命中不回调', () => {
      const { facade, v } = makeFacade()
      const cb = vi.fn()
      const off = facade.onDoubleClick(cb)
      const h = cesiumMock.inputHandlers[0]
      const action = h.setInputAction.mock.calls.find((c: unknown[]) => c[1] === 'LEFT_DOUBLE_CLICK')![0]
      action({ position: { x: 100, y: 200 } })
      expect(v.camera.pickEllipsoid).toHaveBeenCalledWith({ x: 100, y: 200 }, v.scene.globe.ellipsoid)
      expect(cb).toHaveBeenCalledWith((0.5 * 180) / Math.PI, (0.25 * 180) / Math.PI)
      v.camera.pickEllipsoid.mockReturnValueOnce(null)
      action({ position: { x: 100, y: 200 } })
      expect(cb).toHaveBeenCalledTimes(1)
      off()
      expect(h.destroy).toHaveBeenCalledTimes(1)
    })

    it('onPostUpdate 注册/注销 scene.postUpdate', () => {
      const { facade, v } = makeFacade()
      const cb = vi.fn()
      const off = facade.onPostUpdate(cb)
      expect(v.scene.postUpdate.addEventListener).toHaveBeenCalledWith(expect.any(Function))
      const handler = v.scene.postUpdate.addEventListener.mock.calls[0][0]
      handler()
      expect(cb).toHaveBeenCalledTimes(1)
      off()
      expect(v.scene.postUpdate.removeEventListener).toHaveBeenCalledWith(handler)
    })

    it('效果 setter 映射到 scene/globe 属性', () => {
      const { facade, v } = makeFacade()
      facade.setAtmosphere(false)
      expect(v.scene.globe.showGroundAtmosphere).toBe(false)
      facade.setBackgroundColor('#ffffff')
      expect(v.scene.backgroundColor).toEqual({ css: '#ffffff' })
      facade.setSkyBox(false)
      expect(v.scene.skyBox.show).toBe(false)
      facade.setSunMoon(false)
      expect(v.scene.sun.show).toBe(false)
      expect(v.scene.moon.show).toBe(false)
      facade.setFog(true)
      expect(v.scene.fog.enabled).toBe(true)
      facade.setLighting(true)
      expect(v.scene.globe.enableLighting).toBe(true)
      facade.setVerticalExaggeration(2.5)
      expect(v.scene.verticalExaggeration).toBe(2.5)
      facade.setTranslucency(true, 0.4)
      expect(v.scene.globe.translucency.enabled).toBe(true)
      expect(v.scene.globe.translucency.frontFaceAlpha).toBe(0.4)
      expect(v.scene.globe.translucency.backFaceAlpha).toBeCloseTo(0.5)
      facade.setTranslucency(true, 0.95)
      expect(v.scene.globe.translucency.backFaceAlpha).toBe(1)
      facade.setTranslucency(false, 0.4)
      expect(v.scene.globe.translucency.frontFaceAlpha).toBe(1)
      expect(v.scene.globe.translucency.backFaceAlpha).toBe(1)
    })

    it('destroy 时清理共享 input handler', () => {
      const { facade } = makeFacade()
      facade.onPointerDown(vi.fn())
      const h = cesiumMock.inputHandlers[0]
      facade.destroy()
      expect(h.destroy).toHaveBeenCalledTimes(1)
    })

    it('viewer 销毁后相机/效果表面方法安全返回', () => {
      const { facade, v } = makeFacade()
      v.isDestroyed.mockReturnValue(true)
      expect(facade.cameraPosition()).toEqual({ longitude: 0, latitude: 0, height: 0 })
      expect(facade.groundHeight()).toBeUndefined()
      expect(facade.isFlying()).toBe(false)
      expect(() => facade.cancelFlight()).not.toThrow()
      expect(() => facade.moveForward(1)).not.toThrow()
      expect(() => facade.setView({ longitude: 0, latitude: 0, height: 1 }, { heading: 0, pitch: 0, roll: 0 })).not.toThrow()
      expect(() => facade.flyToLonLat(1, 2, 3, { heading: 0, pitch: 0, roll: 0 })).not.toThrow()
      expect(facade.pickLonLat(1, 2)).toBeNull()
      expect(facade.onWheel(vi.fn())).toBeInstanceOf(Function)
      expect(facade.onPointerDown(vi.fn())).toBeInstanceOf(Function)
      expect(facade.onDoubleClick(vi.fn())).toBeInstanceOf(Function)
      expect(facade.onPostUpdate(vi.fn())).toBeInstanceOf(Function)
      expect(() => facade.setAtmosphere(true)).not.toThrow()
      expect(() => facade.setBackgroundColor('#fff')).not.toThrow()
      expect(() => facade.setSkyBox(true)).not.toThrow()
      expect(() => facade.setSunMoon(true)).not.toThrow()
      expect(() => facade.setFog(true)).not.toThrow()
      expect(() => facade.setLighting(true)).not.toThrow()
      expect(() => facade.setVerticalExaggeration(1)).not.toThrow()
      expect(() => facade.setTranslucency(true, 0.5)).not.toThrow()
    })
  })

  describe('图层挂载', () => {
    it('addBaseLayers 首次加入底图与标注，ready 后再加标注层；二次调用跳过', async () => {
      const { facade, v } = makeFacade()
      const runtime = freshRuntime()
      facade.addBaseLayers(runtime)
      expect(v.imageryLayers.list.length).toBe(1)
      expect(runtime.imagery.length).toBe(1)
      await flush()
      expect(v.imageryLayers.list.length).toBe(2)
      expect(runtime.imagery.length).toBe(2)
      facade.addBaseLayers(runtime)
      expect(v.imageryLayers.list.length).toBe(2)
    })

    it('addBaseLayers 标注样式失败时销毁 provider', async () => {
      const { facade } = makeFacade()
      const runtime = freshRuntime()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      maplibreMock.failNext = true
      facade.addBaseLayers(runtime)
      await flush()
      const p = maplibreMock.instances[0]
      expect(p.destroy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('addWebLayerImagery 挂载 ImageryLayer 并应用透明度', async () => {
      const { facade, v } = makeFacade()
      const runtime = freshRuntime()
      const ok = await facade.addWebLayerImagery({ opacity: 0.7 } as never, runtime)
      expect(ok).toBe(true)
      expect(v.imageryLayers.list.length).toBe(1)
      expect(v.imageryLayers.list[0].alpha).toBe(0.7)
      expect(runtime.imagery[0].alpha).toBe(0.7)
    })

    it('addWebLayerImagery 无 provider 时返回 false', async () => {
      const { facade } = makeFacade()
      const ok = await facade.addWebLayerImagery({ fail: true } as never, freshRuntime())
      expect(ok).toBe(false)
    })

    it('addVectorTile ready 后挂载 ImageryLayer 并回调 onDone', async () => {
      const { facade, v } = makeFacade()
      const runtime = freshRuntime()
      const onDone = vi.fn()
      const onError = vi.fn()
      facade.addVectorTile({ styleUrl: 'https://style', opacity: 0.5 } as never, undefined, runtime, () => true, onError, onDone)
      await flush()
      expect(onError).not.toHaveBeenCalled()
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(v.imageryLayers.list.length).toBe(1)
      expect(v.imageryLayers.list[0].alpha).toBe(0.5)
      expect((runtime.imagery[0] as unknown as { provider?: unknown }).provider).toBe(maplibreMock.instances[0])
    })

    it('addVectorTile 样式失败时回调 onError 并销毁 provider', async () => {
      const { facade } = makeFacade()
      const runtime = freshRuntime()
      const onDone = vi.fn()
      const onError = vi.fn()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      facade.addVectorTile({ styleUrl: 'https://fail' } as never, undefined, runtime, () => true, onError, onDone)
      await flush()
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('矢量瓦片渲染失败'))
      expect(onDone).not.toHaveBeenCalled()
      expect(runtime.vectorProviders.length).toBe(0)
      expect(maplibreMock.instances[maplibreMock.instances.length - 1].destroy).toHaveBeenCalled()
      spy.mockRestore()
    })

    it('addVectorTile keepAlive 为 false 时销毁 provider 不挂载', async () => {
      const { facade, v } = makeFacade()
      const runtime = freshRuntime()
      facade.addVectorTile({ styleUrl: 'https://style' } as never, undefined, runtime, () => false, vi.fn(), vi.fn())
      await flush()
      expect(v.imageryLayers.list.length).toBe(0)
      expect(maplibreMock.instances[maplibreMock.instances.length - 1].destroy).toHaveBeenCalled()
    })

    it('addGeoJson 挂载 DataSource 并开启点聚合', async () => {
      const { facade, v } = makeFacade()
      const runtime = freshRuntime()
      const ds = await facade.addGeoJson({ features: [] }, runtime)
      expect(ds).not.toBeNull()
      expect(ds!.clustering.enabled).toBe(true)
      expect(ds!.clustering.pixelRange).toBe(20)
      expect(ds!.clustering.minimumClusterSize).toBe(2)
      expect(v.dataSources.add).toHaveBeenCalledWith(ds)
      expect(runtime.dataSources.length).toBe(1)
    })

    it('addKmlNative 加载并挂载 KML DataSource', async () => {
      const { facade, v } = makeFacade()
      const runtime = freshRuntime()
      const ds = await facade.addKmlNative('https://x/kml', runtime)
      expect(ds).toEqual({ kml: 'https://x/kml' })
      expect(v.dataSources.add).toHaveBeenCalled()
      expect(runtime.dataSources.length).toBe(1)
    })

    it('addScene / add3dTiles 挂载 Primitive', async () => {
      const { facade, v } = makeFacade()
      const runtime = freshRuntime()
      const prim = await facade.addScene('https://i3s', runtime)
      expect(prim).toEqual({ prim: 'i3s-https://i3s' })
      expect(v.scene.primitives.add).toHaveBeenCalledWith(prim)
      expect(runtime.primitives.length).toBe(1)
      const tileset = await facade.add3dTiles('https://tiles', runtime)
      expect(tileset).toEqual({ tileset: '3d-https://tiles' })
      expect(v.scene.primitives.add).toHaveBeenCalledWith(tileset)
      expect(runtime.primitives.length).toBe(2)
    })

    it('viewer 销毁后各挂载方法安全返回', async () => {
      const { facade, v } = makeFacade()
      v.isDestroyed.mockReturnValue(true)
      expect(await facade.addWebLayerImagery({} as never, freshRuntime())).toBe(false)
      expect(await facade.addGeoJson({}, freshRuntime())).toBeNull()
      expect(await facade.addKmlNative('u', freshRuntime())).toBeNull()
      expect(await facade.addScene('u', freshRuntime())).toBeNull()
      expect(await facade.add3dTiles('u', freshRuntime())).toBeNull()
      expect(() => facade.addBaseLayers(freshRuntime())).not.toThrow()
      expect(() => facade.addVectorTile({} as never, undefined, freshRuntime(), () => true, vi.fn(), vi.fn())).not.toThrow()
    })
  })

  describe('视口 / 资源释放', () => {
    it('createViewport 创建控制器、立即更新一次并监听 moveEnd；unsubscribe 幂等移除', async () => {
      const { facade, v } = makeFacade()
      const note = vi.fn()
      const handle = facade.createViewport('https://svc', 200, note)
      expect(viewportMock.controllers.length).toBe(1)
      expect(viewportMock.controllers[0].update).toHaveBeenCalledTimes(1)
      expect(v.camera.moveEnd.addEventListener).toHaveBeenCalledTimes(1)
      handle.unsubscribeMoveEnd()
      handle.unsubscribeMoveEnd()
      expect(v.camera.moveEnd.removeEventListener).toHaveBeenCalledTimes(1)
      expect(note).not.toHaveBeenCalled()
    })

    it('createViewport viewer 销毁时返回 noop 句柄', () => {
      const { facade, v } = makeFacade()
      v.isDestroyed.mockReturnValue(true)
      const handle = facade.createViewport('https://svc', 100)
      expect(viewportMock.controllers.length).toBe(0)
      expect(() => handle.controller.update({ west: 0, south: 0, east: 1, north: 1 })).not.toThrow()
      expect(() => handle.unsubscribeMoveEnd()).not.toThrow()
    })

    it('removeRuntime 释放全部 Cesium 资源且幂等', () => {
      const { facade, v } = makeFacade()
      const layer = { marker: 'il' }
      const ds = { marker: 'ds' }
      const prim = { marker: 'prim' }
      const providerDestroy = vi.fn()
      const runtime = {
        imagery: [{ id: 'i', alpha: 1, dispose: vi.fn(), layer }],
        dataSources: [{ id: 'd', dispose: vi.fn(), ds }],
        primitives: [{ id: 'p', dispose: vi.fn(), prim }],
        vectorProviders: [{ id: 'v', destroy: vi.fn(), provider: { destroy: providerDestroy } }],
        dispose: vi.fn(),
      } as unknown as LayerRuntime
      facade.removeRuntime(runtime)
      expect(v.imageryLayers.remove).toHaveBeenCalledWith(layer, true)
      expect(v.dataSources.remove).toHaveBeenCalledWith(ds, true)
      expect(v.scene.primitives.remove).toHaveBeenCalledWith(prim, true)
      expect(providerDestroy).toHaveBeenCalledTimes(1)
      expect(() => facade.removeRuntime(runtime)).not.toThrow()
    })
  })

  describe('工具函数', () => {
    it('isWebglAvailable 在 jsdom 下返回 true', () => {
      expect(isWebglAvailable()).toBe(true)
    })
  })
})

import { vi } from 'vitest'

/**
 * 共享 Cesium/MapLibre mock（行为级集成测试用）。
 * 与 GlobeViewer.test.tsx 内联 mock 保持一致：fake Viewer 可断言创建/底图/图层/相机/效果。
 * 使用方式：测试文件第一行 import '../mocks/cesium'（在 import App 之前），
 * 再通过 getCesiumMock() / getMaplibreMock() 读取实例。
 *
 * 注意：vitest 不允许导出 vi.hoisted 绑定，因此这里只导出访问器函数。
 */

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
    Cartesian2: {
      clone: (p: unknown) => p,
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

vi.mock('../../globe/facade/maplibreImagery', () => {
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

export function getCesiumMock() {
  return cesiumMock
}

export function getMaplibreMock() {
  return maplibreMock
}

export function resetCesiumMocks() {
  cesiumMock.viewers.length = 0
  cesiumMock.viewerOptions.length = 0
  cesiumMock.imageryLayerInstances.length = 0
  cesiumMock.handlerInstances.length = 0
  maplibreMock.instances.length = 0
}

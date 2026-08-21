import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { GlobeViewer } from './GlobeViewer'
import { useAppStore } from '../state/store'

// ---- Cesium mock（fake Viewer，可断言创建/底图/图层/相机/效果） ----
const cesiumMock = vi.hoisted(() => {
  const viewers: any[] = []
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
    }
    viewers.push(v)
    return v
  }

  return { viewers, imageryLayerInstances, handlerInstances, terrainProviders, makeViewer }
})

vi.mock('cesium', () => {
  const CM = cesiumMock
  return {
    Viewer: vi.fn(function () { return CM.makeViewer() }),
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
  }
})

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
    cesiumMock.imageryLayerInstances.length = 0
    cesiumMock.handlerInstances.length = 0
    useAppStore.setState({
      theme: 'dark',
      added: [],
      effects: freshEffects,
      collapsed: false,
      collapsedRight: false,
      layerErrors: {},
    })
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
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
    expect(v.scene.globe.tileCacheSize).toBe(300)
    expect(v.scene.globe.preloadSiblings).toBe(true)
    expect(v.scene.globe.baseColor).toEqual({ css: '#0d1526' })
    expect(cesiumMock.handlerInstances.length).toBe(1)
    // 地形异步设置
    await act(async () => {})
    expect(v.terrainProvider).toEqual({ terrain: 't' })
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

  it('添加 MapServer webmap → 创建 ImageryLayer 并叠加', async () => {
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
    expect(v.dataSources.add).toHaveBeenCalled()
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
    })
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
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

  it('缩放稳定后 SSE 从 4 回落到 2（迟滞防抖）', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const wheelHandler = v.scene.canvas.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === 'wheel'
    )?.[1] as (e: { deltaY: number; preventDefault: () => void }) => void
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(5000)
    wheelHandler({ deltaY: 100, preventDefault: vi.fn() })
    // 首次帧：diff 大 → SSE 4
    const frameCb = v.scene.postUpdate.addEventListener.mock.calls[0][0] as () => void
    frameCb()
    expect(v.scene.globe.maximumScreenSpaceError).toBe(4)
    // 让相机高度贴近目标高度 → 连续帧稳定
    v.camera.positionCartographic.height = 1250
    for (let i = 0; i < 12; i++) frameCb()
    expect(v.scene.globe.maximumScreenSpaceError).toBe(2)
    nowSpy.mockRestore()
  })

  it('添加 GeoJSON 图层 → GeoJsonDataSource.load 并加入 dataSources', async () => {
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

  it('添加 KML 图层 → KmlDataSource.load 并加入 dataSources', async () => {
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
    await flush()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
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

  it('GeoJSON 加载失败 → setLayerError 并提示', async () => {
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
    expect(useAppStore.getState().layerErrors['gj']).toMatch(/GeoJSON 图层加载失败/)
  })

  it('KML 加载失败 → setLayerError 并提示', async () => {
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
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(useAppStore.getState().layerErrors['kml']).toMatch(/KML 图层加载失败/)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// 必须最先导入：注册 Cesium/MapLibre mock，保证 CesiumFacade/controllers 模块图加载前生效
import '../testing/mocks/cesium'
import { render, act, cleanup, screen } from '@testing-library/react'
import { GlobeViewer } from './GlobeViewer'
import { useAppStore } from './store'
import { getCesiumMock, resetCesiumMocks } from '../testing/mocks/cesium'

const cesiumMock = getCesiumMock()

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
  showReferenceLayers: true,
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
const viewer = () => cesiumMock.viewers[cesiumMock.viewers.length - 1]

function mapServerWebmap() {
  return {
    id: 'wm1',
    title: 'Imagery',
    kind: 'webmap',
    webmap: {
      baseMap: { baseMapLayers: [] },
      operationalLayers: [
        { id: 'op', title: 'World Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
      ],
    },
  }
}

function ownBasemapWebmap() {
  return {
    id: 'wm1',
    title: 'Own Basemap',
    kind: 'webmap',
    webmap: {
      baseMap: {
        baseMapLayers: [
          { title: 'Topo', url: 'https://x/World_Topo_Map/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
        ],
      },
      operationalLayers: [
        { id: 'op', title: 'World Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
      ],
    },
  }
}

describe('GlobeViewer（W3.5 瘦身后）', () => {
  beforeEach(() => {
    resetCesiumMocks()
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
    delete (window as unknown as { __E2E__?: boolean }).__E2E__
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('创建 Viewer：关闭多余控件、添加底图（影像+矢量标注）、接线相机与效果', async () => {
    render(<GlobeViewer />)
    await flush()
    await flush()
    const v = viewer()
    expect(v).toBeDefined()
    expect(cesiumMock.viewerOptions[0]).toMatchObject({
      baseLayer: false,
      baseLayerPicker: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      useBrowserRecommendedResolution: false,
    })
    // 底图：WGS84 影像 + 矢量标注（标注在 provider ready 后加入）
    expect(v.imageryLayers.length).toBe(2)
    // CameraController 接线：滚轮 / postUpdate / 输入 handler
    expect(v.scene.canvas.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false })
    expect(v.scene.postUpdate.addEventListener).toHaveBeenCalled()
    expect(cesiumMock.handlerInstances.length).toBe(1)
    expect(v.scene.globe.tileCacheSize).toBe(100)
    expect(v.scene.globe.preloadSiblings).toBe(false)
    expect(v.scene.globe.baseColor).toEqual({ css: '#0d1526' })
    // 真实地形异步设置
    await act(async () => {})
    expect(v.terrainProvider).toEqual({ terrain: 't' })
  })

  it('静止时使用按需渲染，效果变化时请求一帧刷新', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    const requestsBeforeEffect = v.scene.requestRender.mock.calls.length
    act(() => useAppStore.getState().setEffect('fog', true))
    expect(v.scene.requestRender.mock.calls.length).toBe(requestsBeforeEffect + 1)
  })

  it('浅色主题场景背景使用白色，深色使用深空背景', async () => {
    useAppStore.setState({ theme: 'light' })
    render(<GlobeViewer />)
    await flush()
    expect(viewer().scene.backgroundColor).toEqual({ css: '#ffffff' })
    cleanup()
    resetCesiumMocks()
    useAppStore.setState({ theme: 'dark' })
    render(<GlobeViewer />)
    await flush()
    expect(viewer().scene.backgroundColor).toEqual({ css: '#05070d' })
  })

  it('WebGL 上下文丢失 → 显示降级提示，恢复后清除并请求一帧', async () => {
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
    expect(screen.queryByText(/WebGL 上下文已丢失/)).not.toBeInTheDocument()
    expect(v.scene.requestRender.mock.calls.length).toBe(requestsBeforeRestore + 1)
  })

  it('效果开关映射到 globe 场景（雾/星空/日月/夸张/半透明）', async () => {
    render(<GlobeViewer />)
    await flush()
    const v = viewer()
    act(() => {
      useAppStore.getState().setEffect('atmosphere', true)
      useAppStore.getState().setEffect('fog', true)
      useAppStore.getState().setEffect('stars', false)
      useAppStore.getState().setEffect('sunMoon', true)
      useAppStore.getState().setEffect('dayNight', true)
      useAppStore.getState().setEffect('terrainExaggeration', 2)
      useAppStore.getState().setEffect('globeTranslucency', true)
      useAppStore.getState().setEffect('translucencyAlpha', 0.4)
    })
    expect(v.scene.globe.showGroundAtmosphere).toBe(true)
    expect(v.scene.fog.enabled).toBe(true)
    expect(v.scene.skyBox.show).toBe(false)
    expect(v.scene.sun.show).toBe(true)
    expect(v.scene.moon.show).toBe(true)
    expect(v.scene.globe.enableLighting).toBe(true)
    expect(v.scene.verticalExaggeration).toBe(2)
    expect(v.scene.globe.translucency.enabled).toBe(true)
    expect(v.scene.globe.translucency.frontFaceAlpha).toBe(0.4)
    expect(v.scene.globe.translucency.backFaceAlpha).toBe(0.5)
  })

  it('添加 MapServer webmap → 经 LayerController/renderWebmap 创建 ImageryLayer 并请求刷新', async () => {
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
      useAppStore.getState().addLayer(mapServerWebmap() as never)
    })
    await flush()
    expect(v.imageryLayers.length).toBe(before + 1)
    expect(v.scene.requestRender.mock.calls.length).toBeGreaterThan(requestsBeforeLayer)
    expect(useAppStore.getState().layerErrors['wm1']).toBeUndefined()
  })

  it('业务层超过上限时提示浮层展示省略数量', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }))
    )
    render(<GlobeViewer />)
    await flush()
    act(() => {
      useAppStore.getState().addLayer({
        id: 'many',
        title: 'Many',
        kind: 'webmap',
        webmap: {
          baseMap: { baseMapLayers: [] },
          operationalLayers: Array.from({ length: 8 }, (_, i) => ({
            id: 'm' + i,
            title: 'M' + i,
            url: 'https://x/FeatureServer/0',
            layerType: 'ArcGISFeatureLayer',
          })),
        },
      } as never)
    })
    await flush()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/仅渲染前 5 个/)).toBeInTheDocument()
  })

  it('移除图层 → 从 imageryLayers 移除', async () => {
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
      useAppStore.getState().addLayer(mapServerWebmap() as never)
    })
    await flush()
    const before = v.imageryLayers.length
    act(() => useAppStore.getState().removeLayer('wm1'))
    await flush()
    expect(v.imageryLayers.length).toBe(before - 1)
  })

  it('添加自带底图 webmap → 隐藏固定底图与标注；移除后恢复显示并请求重绘', async () => {
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
    const baseLayer = v.imageryLayers.list[0]
    const labelLayer = v.imageryLayers.list[1]
    act(() => {
      useAppStore.getState().addLayer(ownBasemapWebmap() as never)
    })
    await flush()
    // 自带可替代底图：固定底图与标注应被隐藏
    expect(baseLayer.show).toBe(false)
    expect(labelLayer.show).toBe(false)
    const framesBeforeRemove = v.scene.requestRender.mock.calls.length
    act(() => useAppStore.getState().removeLayer('wm1'))
    await flush()
    // 移除后 added 为空：固定底图与标注恢复，并至少请求一帧把标注渲染出来
    expect(baseLayer.show).toBe(true)
    expect(labelLayer.show).toBe(true)
    expect(v.scene.requestRender.mock.calls.length).toBeGreaterThan(framesBeforeRemove)
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
      expect(cesiumMock.viewers.length).toBe(0)
    } finally {
      spy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('Viewer 创建失败 → 显示地球初始化失败', async () => {
    const { Viewer } = await import('cesium')
    ;(Viewer as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('boom') })
    render(<GlobeViewer />)
    await flush()
    expect(screen.getByText(/地球初始化失败/)).toBeInTheDocument()
  })

  it('__E2E__ 模式跳过 Viewer 创建', async () => {
    ;(window as unknown as { __E2E__?: boolean }).__E2E__ = true
    render(<GlobeViewer />)
    await flush()
    expect(cesiumMock.viewers.length).toBe(0)
  })
})

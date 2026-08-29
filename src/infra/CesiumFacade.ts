/**
 * CesiumFacade（W3.4）：全项目唯一深接触 Cesium 的外观层。
 * - 负责 Viewer 生命周期、地形、影像/矢量瓦片/DataSource/Primitive/KML 的创建与挂载；
 * - 对外只暴露业务语义方法；GlobeViewer / LayerController / CameraController 不直接引用 Cesium 类型。
 */
import * as Cesium from 'cesium'
import type { LayerRuntime } from '../domain/runtime'
import { ArcGisVectorTileImageryProvider } from '../globe/facade/maplibreImagery'
import { GpuMemoryManager } from './GpuMemoryManager'
import {
  estimateSceneCanvasBytes,
  estimateVectorProviderBytes,
  type GpuTierConfig,
} from '../globe/facade/gpuBudget'
import {
  providerForWebLayer,
  WORLD_IMAGERY_WGS84_TILES,
  WORLD_VECTOR_LABELS_STYLE_URL,
  type WebLayer,
} from '../globe/facade/webmap'
import { viewEnvelopeFromCamera } from '../globe/viewport/envelope'
import {
  createViewportController,
  type ViewportController,
} from '../globe/viewport/viewportController'
import { loadI3S, load3DTiles } from '../globe/facade/scene'
import { registerViewer, unregisterViewer, flyToHome } from '../globe/facade/cameraApi'
import type { ViewEnvelope } from '../globe/viewport/featureQuery'

// 地形：Terrain3D (GCSv2, EPSG:4326)，覆盖 ±90°（3857 版只到 ±85.05°，会导致极区无 globe tile）
const TERRAIN_URL =
  'https://tiles.arcgis.com/tiles/HDgMIJDCbHtnomY9/arcgis/rest/services/Terrain_3D_GCSv2/ImageServer'

// 缓存地形 Provider（跨 Facade 实例共享，重建 viewer 不重复请求）
let cachedTerrain: Cesium.TerrainProvider | null = null
let terrainLoading: Promise<Cesium.TerrainProvider> | null = null

/** 测试用：重置地形 Provider 缓存（避免跨用例共享模块级状态）。 */
export function __resetTerrainCacheForTest() {
  cachedTerrain = null
  terrainLoading = null
}

/** 创建 Viewer 时的回调（WebGL 上下文丢失/恢复，UI 提示由 Presentation 层处理）。 */
export interface FacadeLifecycleCallbacks {
  onContextLost?: (msg: string) => void
  onContextRestored?: () => void
  onInitError?: (msg: string) => void
}

export interface FacadeViewportHandle {
  controller: ViewportController
  /** 移除相机 moveEnd 监听；幂等。 */
  unsubscribeMoveEnd(): void
}

/** 检测 WebGL 是否可用；在 jsdom 测试环境下返回 true，避免误判为不可用。 */
export function isWebglAvailable(): boolean {
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return true
  try {
    const c = document.createElement('canvas')
    if (!c || typeof c.getContext !== 'function') return false
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')
    return !!gl
  } catch {
    return false
  }
}

/** 点要素聚合：大量点合并为少量聚合点，降低渲染量 */
export function enablePointClustering(ds: Cesium.DataSource) {
  const c = (ds as { clustering?: { enabled: boolean; pixelRange: number; minimumClusterSize: number; clusterBillboards: boolean } }).clustering
  if (!c) return
  c.enabled = true
  c.pixelRange = 20
  c.minimumClusterSize = 2
  c.clusterBillboards = true
}

export class CesiumFacade {
  viewer: Cesium.Viewer | null = null

  /** GPU 内存预算管理器：统一档位 → 主场景 resolutionScale + provider 重建 */
  private _gpu: GpuMemoryManager | null = null
  private _gpuUnsub: (() => void) | null = null
  /** 相机是否在移动（critical 档离屏渲染暂停的判据） */
  private _cameraMoving = false
  /** 矢量瓦片 provider 重建表：档位变化时逐个销毁重建（key → 重建 thunk） */
  private readonly _vectorRebuilds = new Map<string, () => void>()
  private readonly _vectorProviders = new Map<string, ArcGisVectorTileImageryProvider>()
  private readonly _vectorTokens = new Map<string, number>()
  private _vectorSeq = 0
  private _labelsProvider: ArcGisVectorTileImageryProvider | null = null
  private _labelsToken = 0
  /** 档位重建中：阻止嵌套 _applyTier（重建时 register/unregister 触发核算） */
  private _applyingTier = false
  /** 相机运动监听是否已注册（有矢量 provider 时才需要） */
  private _cameraTracked = false

  /** 创建并挂载 Viewer；返回是否成功。E2E 跳过由调用方（Presentation）判定。 */
  create(el: HTMLElement, cb: FacadeLifecycleCallbacks = {}): boolean {
    let v: Cesium.Viewer
    try {
      v = new Cesium.Viewer(el, {
        baseLayer: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        animation: false,
        timeline: false,
        selectionIndicator: false,
        infoBox: false,
        // 静止场景不再持续提交 GPU 帧；图层/效果/交互变化时显式 requestRender。
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
        // 默认 true 会忽略 devicePixelRatio 按 1x 渲染，高分屏下整球被拉伸发虚；false 跟随系统 DPI
        useBrowserRecommendedResolution: false,
      })
    } catch (e) {
      console.error('[globe] 初始化失败', e)
      cb.onInitError?.('地球初始化失败：' + String(e).slice(0, 120))
      return false
    }
    this.viewer = v
    registerViewer(v)
    // WebGL 上下文丢失预案（内存不足/卡死时不白屏：易加载并提示）
    const onCtxLost = (e: Event) => {
      e.preventDefault()
      cb.onContextLost?.('WebGL 上下文已丢失（可能内存不足，正在尝试恢复…）')
    }
    const onCtxRestored = () => {
      cb.onContextRestored?.()
      this.requestFrame()
    }
    v.scene.canvas.addEventListener('webglcontextlost', onCtxLost)
    v.scene.canvas.addEventListener('webglcontextrestored', onCtxRestored)
    // Defer the final redraw out of the current frame so requestRenderMode
    // does not swallow the render after the last tile arrives.
    const onTileLoadProgress = (remaining: number) => {
      if (remaining > 0) {
        this.requestFrame()
        return
      }
      window.setTimeout(() => {
        if (!v.isDestroyed()) this.requestFrame()
      }, 0)
    }
    v.scene.globe.tileLoadProgressEvent.addEventListener(onTileLoadProgress)
    // 关闭 Bloom 泛光（移除图层发光高亮）
    v.scene.postProcessStages.bloom.enabled = false
    // 球体基色：图层加载间隙用深色，避免露蓝
    v.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1526')
    ;(window as unknown as { __evViewer: Cesium.Viewer; __Cesium: typeof Cesium }).__evViewer = v
    ;(window as unknown as { __Cesium: typeof Cesium }).__Cesium = Cesium
    // 相机控制器基础限制（交互细节归 CameraController）
    const scc = v.scene.screenSpaceCameraController
    scc.tiltEventTypes = Cesium.CameraEventType.RIGHT_DRAG
    scc.zoomEventTypes = [Cesium.CameraEventType.PINCH]
    v.scene.globe.tileCacheSize = 100
    v.scene.globe.preloadSiblings = false
    // ---- GPU 内存预算：主场景渲染缓冲计入核算，档位变化 → resolutionScale + 重建 provider ----
    this._gpu = new GpuMemoryManager()
    const gpu = this._gpu
    gpu.register('scene', {
      estimateBytes: (tier) => {
        const c = v.scene.canvas
        const w = c.width || Math.max(1, c.clientWidth * window.devicePixelRatio)
        const h = c.height || Math.max(1, c.clientHeight * window.devicePixelRatio)
        return estimateSceneCanvasBytes(w, h, tier)
      },
    })
    this._gpuUnsub = gpu.subscribe((tier) => this._applyTier(tier))
    this._applyTier(gpu.current(), false)
    return true
  }

  /** requestRenderMode 下按需渲染一帧。 */
  requestFrame() {
    const v = this.viewer
    if (v && !v.isDestroyed()) v.scene.requestRender()
  }

  /** 设置 globe 的最大屏幕空间误差（瓦片清晰度）。 */
  setScreenSpaceError(value: number) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    const globe = v.scene.globe
    if (globe.maximumScreenSpaceError !== value) globe.maximumScreenSpaceError = value
  }

  // ---- 相机表面（供 CameraController 使用；只暴露业务语义，不泄漏 Cesium 类型） ----

  /** 当前相机位置：经度/纬度（弧度）+ 高度（米）。 */
  cameraPosition(): { longitude: number; latitude: number; height: number } {
    const v = this.viewer
    if (!v || v.isDestroyed()) return { longitude: 0, latitude: 0, height: 0 }
    const c = v.camera.positionCartographic
    return { longitude: c.longitude, latitude: c.latitude, height: c.height }
  }

  /** 当前相机朝向（heading/pitch/roll，弧度）。 */
  cameraOrientation(): { heading: number; pitch: number; roll: number } {
    const v = this.viewer
    if (!v || v.isDestroyed()) return { heading: 0, pitch: 0, roll: 0 }
    return { heading: v.camera.heading, pitch: v.camera.pitch, roll: v.camera.roll }
  }

  /** 相机正下方地形高度（米）；无数据返回 undefined。 */
  groundHeight(): number | undefined {
    const v = this.viewer
    if (!v || v.isDestroyed()) return undefined
    return v.scene.globe.getHeight(v.camera.positionCartographic)
  }

  /** 是否处于飞行动画中（内部 _currentFlight 探测）。 */
  isFlying(): boolean {
    const v = this.viewer
    if (!v || v.isDestroyed()) return false
    const c = v.camera as unknown as { _currentFlight?: unknown }
    return !!c._currentFlight
  }

  /** 取消飞行动画（无飞行时静默）。 */
  cancelFlight() {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    try {
      const c = v.camera as unknown as { _currentFlight?: unknown }
      if (c._currentFlight) v.camera.cancelFlight()
    } catch {
      // 忽略
    }
  }

  /** 沿相机视向移动指定距离（滚轮缓动用）。 */
  moveForward(distance: number) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.camera.moveForward(distance)
  }

  /** 直接设置相机位置（弧度坐标）+ 朝向。 */
  setView(
    position: { longitude: number; latitude: number; height: number },
    orientation: { heading: number; pitch: number; roll: number }
  ) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(position.longitude, position.latitude, position.height),
      orientation,
    })
  }

  /** 飞行到指定经纬度（度）+ 高度，并请求一帧。 */
  flyToLonLat(
    lon: number,
    lat: number,
    height: number,
    orientation: { heading: number; pitch: number; roll: number }
  ) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation,
    })
    this.requestFrame()
  }

  /** 屏幕坐标拾取 → 经纬度（度）；未命中椭球返回 null。 */
  pickLonLat(x: number, y: number): { lon: number; lat: number } | null {
    const v = this.viewer
    if (!v || v.isDestroyed()) return null
    const picked = v.camera.pickEllipsoid({ x, y } as unknown as Cesium.Cartesian2, v.scene.globe.ellipsoid)
    if (!picked) return null
    const carto = v.scene.globe.ellipsoid.cartesianToCartographic(picked)
    return { lon: Cesium.Math.toDegrees(carto.longitude), lat: Cesium.Math.toDegrees(carto.latitude) }
  }

  /** 注册滚轮监听（passive:false 以便 preventDefault）；返回注销函数。 */
  onWheel(cb: (e: WheelEvent) => void): () => void {
    const v = this.viewer
    if (!v || v.isDestroyed()) return () => {}
    const h = (e: WheelEvent) => cb(e)
    v.scene.canvas.addEventListener('wheel', h, { passive: false })
    return () => v.scene.canvas.removeEventListener('wheel', h)
  }

  /** 注册鼠标按下（左/右/中）监听；返回注销函数。 */
  onPointerDown(cb: () => void): () => void {
    const h = this.acquireInputHandler()
    if (!h) return () => {}
    const act = () => cb()
    h.setInputAction(act, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    h.setInputAction(act, Cesium.ScreenSpaceEventType.RIGHT_DOWN)
    h.setInputAction(act, Cesium.ScreenSpaceEventType.MIDDLE_DOWN)
    return () => this.releaseInputHandler()
  }

  /** 注册双击监听（拾取后回调经纬度，度）；返回注销函数。 */
  onDoubleClick(cb: (lon: number, lat: number) => void): () => void {
    const v = this.viewer
    const h = this.acquireInputHandler()
    if (!h || !v) return () => {}
    h.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      const picked = v.camera.pickEllipsoid(movement.position, v.scene.globe.ellipsoid)
      if (!picked) return
      const carto = v.scene.globe.ellipsoid.cartesianToCartographic(picked)
      cb(Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude))
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    return () => this.releaseInputHandler()
  }

  /** 注册每帧回调（postUpdate）；返回注销函数。 */
  onPostUpdate(cb: () => void): () => void {
    const v = this.viewer
    if (!v || v.isDestroyed()) return () => {}
    const h = () => cb()
    v.scene.postUpdate.addEventListener(h)
    return () => v.scene.postUpdate.removeEventListener(h)
  }

  // ---- 效果表面（供 EffectsController 使用；业务语义，不泄漏 Cesium 类型） ----

  setAtmosphere(show: boolean) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.scene.globe.showGroundAtmosphere = show
  }

  setBackgroundColor(color: string) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.scene.backgroundColor = Cesium.Color.fromCssColorString(color)
  }

  setSkyBox(show: boolean) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    if (v.scene.skyBox) v.scene.skyBox.show = show
  }

  setSunMoon(show: boolean) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    if (v.scene.sun) v.scene.sun.show = show
    if (v.scene.moon) v.scene.moon.show = show
  }

  setFog(enabled: boolean) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.scene.fog.enabled = enabled
  }

  setLighting(enabled: boolean) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.scene.globe.enableLighting = enabled
  }

  setVerticalExaggeration(value: number) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.scene.verticalExaggeration = value
  }

  setTranslucency(enabled: boolean, alpha: number) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    const g = v.scene.globe
    if (!g.translucency) return
    g.translucency.enabled = enabled
    // Cesium 的 frontFaceAlpha/backFaceAlpha 默认 1（完全不透明），需显式调低才有半透明效果
    g.translucency.frontFaceAlpha = enabled ? alpha : 1
    g.translucency.backFaceAlpha = enabled ? Math.min(1, alpha + 0.1) : 1
  }

  private inputHandler: Cesium.ScreenSpaceEventHandler | null = null
  private inputRefs = 0

  private acquireInputHandler(): Cesium.ScreenSpaceEventHandler | null {
    const v = this.viewer
    if (!v || v.isDestroyed()) return null
    if (!this.inputHandler) this.inputHandler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    this.inputRefs++
    return this.inputHandler
  }

  private releaseInputHandler() {
    this.inputRefs--
    if (this.inputRefs <= 0 && this.inputHandler) {
      this.inputHandler.destroy()
      this.inputHandler = null
      this.inputRefs = 0
    }
  }

  getTerrainProvider(): Promise<Cesium.TerrainProvider> {
    if (cachedTerrain) return Promise.resolve(cachedTerrain)
    if (!terrainLoading) {
      terrainLoading = Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_URL).then((p) => {
        cachedTerrain = p
        return p
      })
    }
    return terrainLoading
  }

  /** 真实地形始终开启（缓存 Provider + 光照阴影）；加载完成请求一帧。 */
  async applyTerrain(): Promise<void> {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    const p = await this.getTerrainProvider()
    if (v.isDestroyed()) return
    v.terrainProvider = p
    this.requestFrame()
  }

  /** 相机飞到指定目的地/朝向。 */
  flyTo(destination: unknown, orientation?: { heading: number; pitch: number; roll: number }) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.camera.flyTo({ destination: destination as Cesium.Cartesian3 | Cesium.Rectangle, orientation })
    this.requestFrame()
  }

  /** 飞到给定范围（用于 Feature 服务数据范围）。 */
  flyToExtent(ext: ViewEnvelope) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    v.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(ext.west, ext.south, ext.east, ext.north),
    })
    this.requestFrame()
  }

  /** 当前视口 envelope（无则回退全局，由调用方补默认值）。 */
  viewEnvelope(): ViewEnvelope | null {
    const v = this.viewer
    if (!v || v.isDestroyed()) return null
    return viewEnvelopeFromCamera(v.scene.camera as never)
  }

  /** 飞回"程序初始位置"（cameraApi 内异步取用户位置）。 */
  flyToHome() {
    void flyToHome(this.viewer ?? undefined)
  }

  /**
   * 添加底图（仅首次）：WGS84 World Imagery + 官方 Hybrid Reference 矢量标注。
   * 与 GlobeViewer 原行为一致：标注在样式 ready 后加入。
   */
  addBaseLayers(runtime: LayerRuntime) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    const layers = v.imageryLayers
    if (layers.length > 0) return
    const base = new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: WORLD_IMAGERY_WGS84_TILES,
        tilingScheme: new Cesium.GeographicTilingScheme(),
        maximumLevel: 22,
      })
    )
    layers.add(base, 0)
    this.pushImagery(runtime, base)
    this._attachLabels(runtime)
    this.requestFrame()
  }

  /** 创建/重建底图标注 provider（档位变化时由 _vectorRebuilds 触发）。 */
  private _attachLabels(runtime: LayerRuntime) {
    const v = this.viewer
    const gpu = this._gpu
    if (!v || v.isDestroyed() || !gpu) return
    this._ensureCameraTracking()
    const token = ++this._labelsToken
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: WORLD_VECTOR_LABELS_STYLE_URL,
      language: 'en',
      labelsOnly: true,
      labelScope: 'country-city',
      // 参考 Map Viewer 实际效果：白字 + 黑色描边，字体用样式默认（Arial Bold）
      styleOverrides: {
        textColor: '#ffffff',
        haloColor: '#000000',
        haloWidth: 1.5,
        // 低空观察时深层标注更大：z6 以下 1.15，逐渐到 z16 以上 1.6
        textScale: { lowZoom: 6, highZoom: 16, lowScale: 1.15, highScale: 1.6 },
      },
      title: 'World Labels',
      gpuTier: gpu.current(),
      onContextLost: () => this._gpu?.reportContextLost(),
      canRenderNow: () => this._canRenderOffscreen(),
    })
    this._labelsProvider = provider
    gpu.register('labels', { estimateBytes: (tier) => estimateVectorProviderBytes(tier) })
    this._vectorRebuilds.set('labels', () => {
      if (this._labelsProvider) {
        this._removeVectorImagery(runtime, this._labelsProvider)
        this._labelsProvider.destroy()
        this._labelsProvider = null
      }
      this._attachLabels(runtime)
    })
    provider.readyPromise
      .then(() => {
        if (v.isDestroyed() || token !== this._labelsToken || !this._gpu) {
          provider.destroy()
          return
        }
        // 重建时若旧实例已挂载则先移除（首次挂载 findIndex 为 -1，不销毁新 provider）
        this._removeVectorImagery(runtime, provider)
        const il = new Cesium.ImageryLayer(provider as unknown as Cesium.ImageryProvider)
        v.imageryLayers.add(il)
        this.pushImagery(runtime, il, provider)
        this.requestFrame()
      })
      .catch((e: unknown) => {
        if (token !== this._labelsToken) {
          // 已被档位重建取代：静默销毁旧实例，避免刷屏与误报
          provider.destroy()
          return
        }
        console.error('[globe] 矢量标注样式加载失败', e)
        provider.destroy()
        this._labelsProvider = null
      })
  }

  /** 影像类图层（MapServer/ImageServer/WMS/WMTS/OSM/urlTemplate）→ ImageryLayer。 */
  async addWebLayerImagery(
    op: WebLayer,
    runtime: LayerRuntime,
    signal?: AbortSignal,
    keepAlive?: () => boolean
  ): Promise<boolean> {
    const v = this.viewer
    if (!v || v.isDestroyed()) return false
    const img = await providerForWebLayer(op, signal)
    if (!img) return false
    // 探测期间图层可能已被移除：挂载前回查，避免把影像层挂到已释放的 runtime
    if (!v || v.isDestroyed() || (keepAlive && !keepAlive())) {
      ;(img as unknown as { destroy?: () => void }).destroy?.()
      return false
    }
    const il = new Cesium.ImageryLayer(img)
    if (typeof op.opacity === 'number') il.alpha = op.opacity
    v.imageryLayers.add(il)
    this.pushImagery(runtime, il)
    this.requestFrame()
    return true
  }

  /** 矢量瓦片图层：MapLibre 样式 provider → ImageryLayer（ready 后挂载）。 */
  addVectorTile(
    op: WebLayer,
    signal: AbortSignal | undefined,
    runtime: LayerRuntime,
    keepAlive: () => boolean,
    onError: (msg: string) => void,
    onDone: () => void
  ) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    // key 需唯一：同一业务 URL 可能被添加多次（多个 runtime），
    // 若共用同一 key 会覆盖 rebuild/token/GPU 核算，导致先添加的图层静默失败或误清理。
    const key = 'vt:' + (op.styleUrl ?? op.url ?? op.title ?? 'vector') + '#' + ++this._vectorSeq
    this._attachVectorTile(key, op, signal, runtime, keepAlive, onError, onDone)
  }

  /** 创建/重建业务矢量瓦片 provider（档位变化时由 _vectorRebuilds 触发）。 */
  private _attachVectorTile(
    key: string,
    op: WebLayer,
    signal: AbortSignal | undefined,
    runtime: LayerRuntime,
    keepAlive: () => boolean,
    onError: (msg: string) => void,
    onDone: () => void
  ) {
    const v = this.viewer
    const gpu = this._gpu
    if (!v || v.isDestroyed() || !gpu) return
    this._ensureCameraTracking()
    const token = (this._vectorTokens.get(key) ?? 0) + 1
    this._vectorTokens.set(key, token)
    const provider = new ArcGisVectorTileImageryProvider({
      styleUrl: op.styleUrl,
      url: op.url,
      title: op.title,
      signal,
      gpuTier: gpu.current(),
      onContextLost: () => this._gpu?.reportContextLost(),
      canRenderNow: () => this._canRenderOffscreen(),
    })
    this._vectorProviders.set(key, provider)
    gpu.register(key, { estimateBytes: (tier) => estimateVectorProviderBytes(tier) })
    this._vectorRebuilds.set(key, () => {
      const cur = this._vectorProviders.get(key)
      if (cur) {
        this._removeVectorImagery(runtime, cur)
        cur.destroy()
      }
      this._vectorProviders.delete(key)
      this._attachVectorTile(key, op, signal, runtime, keepAlive, onError, onDone)
    })
    provider.readyPromise
      .then(() => {
        if (!keepAlive() || token !== this._vectorTokens.get(key) || v.isDestroyed()) {
          if (this._vectorProviders.get(key) === provider) this._vectorProviders.delete(key)
          provider.destroy()
          return
        }
        // 重建时若旧实例已挂载则先移除（首次挂载 findIndex 为 -1，不销毁新 provider）
        this._removeVectorImagery(runtime, provider)
        const il = new Cesium.ImageryLayer(provider as unknown as Cesium.ImageryProvider)
        if (typeof op.opacity === 'number') il.alpha = op.opacity
        v.imageryLayers.add(il)
        this.pushImagery(runtime, il, provider)
        this.requestFrame()
        onDone()
      })
      .catch((e: unknown) => {
        if (token !== this._vectorTokens.get(key)) {
          // 已被档位重建取代：静默销毁旧实例，不向用户报错
          provider.destroy()
          return
        }
        console.error('[layer] 矢量瓦片样式渲染失败', op.url || op.styleUrl, e)
        if (this._vectorProviders.get(key) === provider) this._vectorProviders.delete(key)
        provider.destroy()
        onError('矢量瓦片渲染失败：' + (op.title || op.url || op.styleUrl))
      })
  }

  /** GPU 档位变化：主场景 resolutionScale + 以新档位重建全部矢量 provider。 */
  private _applyTier(tier: GpuTierConfig, requestRender = true) {
    if (this._applyingTier) return
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    this._applyingTier = true
    try {
      if (v.resolutionScale !== tier.resolutionScale) {
        v.resolutionScale = tier.resolutionScale
      }
      for (const rebuild of this._vectorRebuilds.values()) rebuild()
    } finally {
      this._applyingTier = false
    }
    if (requestRender) this.requestFrame()
  }

  /** 懒注册相机运动监听：critical 档下相机静止时暂停离屏矢量渲染。 */
  private _ensureCameraTracking() {
    if (this._cameraTracked) return
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    this._cameraTracked = true
    // 真实 Cesium 中 viewer.camera 与 viewer.scene.camera 是同一对象；双路径兼容测试 mock
    const cam = (v.scene?.camera ?? v.camera) as { moveStart?: Cesium.Event; moveEnd?: Cesium.Event }
    cam.moveStart?.addEventListener(() => {
      this._cameraMoving = true
    })
    cam.moveEnd?.addEventListener(() => {
      this._cameraMoving = false
      this.requestFrame()
    })
  }

  /** critical 档：相机静止时暂停离屏矢量渲染，移动时恢复出图。 */
  private _canRenderOffscreen(): boolean {
    const gpu = this._gpu
    if (!gpu || gpu.tierName() !== 'critical') return true
    return this._cameraMoving
  }

  /** 从 runtime.imagery 与 viewer.imageryLayers 中移除指定 provider 的影像图层（不销毁 provider）。 */
  private _removeVectorImagery(runtime: LayerRuntime, provider: ArcGisVectorTileImageryProvider) {
    const v = this.viewer
    const idx = runtime.imagery.findIndex(
      (l) => (l as unknown as { provider?: unknown }).provider === provider
    )
    if (idx < 0) return
    const entry = runtime.imagery[idx] as unknown as {
      layer?: Cesium.ImageryLayer
      provider?: ArcGisVectorTileImageryProvider
    }
    if (entry.layer && v && !v.isDestroyed()) {
      v.imageryLayers.remove(entry.layer, true)
    }
    runtime.imagery.splice(idx, 1)
  }

  /** 图层移除时清理 GPU 核算与重建/实例追踪（provider 由调用方销毁）。 */
  private _forgetVectorTracking(key: string) {
    this._gpu?.unregister(key)
    this._vectorRebuilds.delete(key)
    this._vectorProviders.delete(key)
    this._vectorTokens.delete(key)
    if (key === 'labels') this._labelsProvider = null
  }

  /** 加载 GeoJSON → DataSource（可带 Cesium 样式参数），挂 runtime 并开启点聚合。 */
  async addGeoJson(
    data: unknown,
    runtime: LayerRuntime,
    style?: {
      markerColor?: Cesium.Color
      markerSize?: number
      stroke?: Cesium.Color
      strokeWidth?: number
      fill?: Cesium.Color
    },
    keepAlive?: () => boolean
  ): Promise<Cesium.DataSource | null> {
    const v = this.viewer
    if (!v || v.isDestroyed()) return null
    const ds = await Cesium.GeoJsonDataSource.load(
      data as never,
      style
        ? {
            markerColor: style.markerColor,
            markerSize: style.markerSize,
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
            fill: style.fill,
          }
        : undefined
    )
    // 加载期间图层可能已被移除：挂载前回查存活状态，避免把资源挂到已释放的 runtime
    if (!v || v.isDestroyed() || (keepAlive && !keepAlive())) {
      ;(ds as unknown as { destroy?: () => void }).destroy?.()
      return null
    }
    this.addDataSource(ds as Cesium.DataSource, runtime)
    return ds as Cesium.DataSource
  }

  /** 原生 KML（图标/样式回退路径）。 */
  async addKmlNative(
    url: string,
    runtime: LayerRuntime,
    keepAlive?: () => boolean
  ): Promise<Cesium.DataSource | null> {
    const v = this.viewer
    if (!v || v.isDestroyed()) return null
    const ds = await Cesium.KmlDataSource.load(url)
    if (!v || v.isDestroyed() || (keepAlive && !keepAlive())) {
      ;(ds as unknown as { destroy?: () => void }).destroy?.()
      return null
    }
    this.addDataSource(ds as Cesium.DataSource, runtime)
    return ds as Cesium.DataSource
  }

  /** 把 DataSource 挂到球上（含点聚合）。 */
  addDataSource(ds: Cesium.DataSource, runtime: LayerRuntime) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    enablePointClustering(ds)
    v.dataSources.add(ds)
    this.pushDataSource(runtime, ds)
    this.requestFrame()
  }

  /** 3D 场景（I3S）。 */
  async addScene(url: string, runtime: LayerRuntime, keepAlive?: () => boolean): Promise<unknown> {
    const v = this.viewer
    if (!v || v.isDestroyed()) return null
    const prim = await loadI3S(url)
    if (!prim) return null
    if (!v || v.isDestroyed() || (keepAlive && !keepAlive())) {
      ;(prim as unknown as { destroy?: () => void }).destroy?.()
      return null
    }
    v.scene.primitives.add(prim)
    this.pushPrimitive(runtime, prim)
    this.requestFrame()
    return prim
  }

  /** OGC 3D Tiles。 */
  async add3dTiles(url: string, runtime: LayerRuntime, keepAlive?: () => boolean): Promise<unknown> {
    const v = this.viewer
    if (!v || v.isDestroyed()) return null
    const tileset = await load3DTiles(url)
    if (!tileset) return null
    if (!v || v.isDestroyed() || (keepAlive && !keepAlive())) {
      ;(tileset as unknown as { destroy?: () => void }).destroy?.()
      return null
    }
    v.scene.primitives.add(tileset)
    this.pushPrimitive(runtime, tileset)
    this.requestFrame()
    return tileset
  }

  /**
   * 视口驱动 Primitive：创建视口控制器 + moveEnd 监听。
   * 返回句柄由调用方持有（dispose / 移除监听由 facade 负责）。
   */
  createViewport(serviceUrl: string, maxFeatures: number, onNote?: (msg: string) => void): FacadeViewportHandle {
    const v = this.viewer
    const noop: FacadeViewportHandle = {
      controller: { update: async () => {}, dispose: () => {} },
      unsubscribeMoveEnd: () => {},
    }
    if (!v || v.isDestroyed()) return noop
    const ctl = createViewportController(v.scene, v.scene.primitives, {
      serviceUrl,
      maxFeatures,
      onNote,
    })
    let disposed = false
    const updateViewport = () =>
      ctl.update(this.viewEnvelope() ?? { west: -180, south: -90, east: 180, north: 90 }).finally(() => this.requestFrame())
    const handler = debounce(() => void updateViewport(), 250)
    const moveEnd = (v.camera.moveEnd as unknown as { addEventListener?: (h: () => void) => void } | undefined)
    moveEnd?.addEventListener?.(handler)
    void updateViewport()
    return {
      controller: ctl,
      unsubscribeMoveEnd: () => {
        if (disposed) return
        disposed = true
        const me = (v.camera.moveEnd as unknown as { removeEventListener?: (h: () => void) => void } | undefined)
        me?.removeEventListener?.(handler)
      },
    }
  }

  /** 一次性释放 runtime 全部 Cesium 资源；幂等。 */
  removeRuntime(runtime: LayerRuntime) {
    const v = this.viewer
    if (!v || v.isDestroyed()) return
    // GPU 核算/重建追踪清理：runtime 内的矢量 provider（labels 或业务矢量瓦片）
    const keysToForget = new Set<string>()
    for (const [key, provider] of this._vectorProviders) {
      if (runtime.imagery.some((l) => (l as unknown as { provider?: unknown }).provider === provider)) {
        keysToForget.add(key)
      }
    }
    if (
      this._labelsProvider &&
      runtime.imagery.some((l) => (l as unknown as { provider?: unknown }).provider === this._labelsProvider)
    ) {
      keysToForget.add('labels')
    }
    for (const key of keysToForget) this._forgetVectorTracking(key)
    runtime.imagery.forEach((l) => {
      const il = (l as unknown as { layer?: Cesium.ImageryLayer }).layer
      if (il) v.imageryLayers.remove(il, true)
      const provider = (l as unknown as { provider?: { destroy(): void } }).provider
      provider?.destroy?.()
    })
    runtime.vectorProviders.forEach((p) => {
      ;(p as unknown as { provider?: { destroy(): void } }).provider?.destroy()
    })
    runtime.dataSources.forEach((d) => {
      const ds = (d as unknown as { ds?: Cesium.DataSource }).ds
      if (ds) v.dataSources.remove(ds, true)
    })
    runtime.primitives.forEach((p) => {
      const prim = (p as unknown as { prim?: unknown }).prim
      if (prim !== undefined) {
        ;(v.scene.primitives.remove as (p: unknown, destroy?: boolean) => boolean)(prim, true)
      }
    })
  }

  destroy() {
    const v = this.viewer
    if (!v) return
    this._gpuUnsub?.()
    this._gpuUnsub = null
    this._gpu = null
    for (const provider of this._vectorProviders.values()) provider.destroy()
    this._labelsProvider?.destroy()
    this._labelsProvider = null
    this._vectorRebuilds.clear()
    this._vectorProviders.clear()
    this._vectorTokens.clear()
    this.inputHandler?.destroy()
    this.inputHandler = null
    this.inputRefs = 0
    unregisterViewer()
    v.destroy()
    this.viewer = null
  }

  private pushImagery(runtime: LayerRuntime, layer: Cesium.ImageryLayer, provider?: { destroy(): void }) {
    runtime.imagery.push({
      id: crypto?.randomUUID?.() ?? String(runtime.imagery.length),
      alpha: layer.alpha,
      dispose: () => {},
      ...(({ layer, provider }) => ({ layer, provider }))({ layer, provider }),
    } as never)
  }

  private pushDataSource(runtime: LayerRuntime, ds: Cesium.DataSource) {
    runtime.dataSources.push({
      id: crypto?.randomUUID?.() ?? String(runtime.dataSources.length),
      dispose: () => {},
      ds,
    } as never)
  }

  private pushPrimitive(runtime: LayerRuntime, prim: unknown) {
    runtime.primitives.push({
      id: crypto?.randomUUID?.() ?? String(runtime.primitives.length),
      dispose: () => {},
      prim,
    } as never)
  }
}

/** 防抖：相机移动结束后等待 ms 再触发，避免快速缩放/拖动时视口查询风暴 */
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined
  return ((...args: unknown[]) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

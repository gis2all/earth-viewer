import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { useAppStore } from '../state/store'

const useLayerError = () => useAppStore((s) => s.setLayerError)
const useClearLayerError = () => useAppStore((s) => s.clearLayerError)
import { registerViewer, unregisterViewer, flyToHome } from './cameraApi'
import { renderableLayersFromWebmap, skippedBusinessLayers, MAX_BUSINESS_LAYERS } from './assess'
import { SAFETY, assertUrlWithinLimit, consumeFeatureBudget } from './loadSafety'
import { applyVertexBudget } from './viewport/budget'
import { queryViewportData } from './viewport/query'
import { resolveFeatureQueryBase, resolveFeatureService } from './viewport/featureQuery'
import { runViewportProcess } from './viewport/worker'
import { hasPrimitiveRendering } from './viewport/primitive'
import { createViewportController } from './viewport/viewportController'
import { viewEnvelopeFromCamera } from './viewport/envelope'
import {
  providerForWebLayer,
  isFeatureLayer,
  isGeoJsonLayer,
  isFeatureCollectionLayer,
  isKmlLayer,
  isVectorTileLayer,
  isSceneLayer,
  is3dTilesLayer,
  isWfsLayer,
  isCsvLayer,
  fetchFeatureStyle,
  fetchFeatureRenderer,
  withFetchTimeout,
  WORLD_IMAGERY_WGS84_TILES,
  WORLD_VECTOR_LABELS_STYLE_URL,
} from './webmap'
import { rendererToStyleFn, applyFeatureStyler, reprojectCoordinates, type FeatureStyleSpec } from './vector'
import { loadI3S, load3DTiles } from './scene'
import { parseKmlToGeoJSON, kmlStyleToFeatureStyle, type KmlStyleSpec } from './kml'
import { fetchOgcFeatureGeoJSON } from './ogc'
import { ArcGisVectorTileImageryProvider } from './maplibreImagery'
import { fetchCsvGeoJSON } from './csv'

// 地形：Terrain3D (GCSv2, EPSG:4326)，覆盖 ±90°（3857 版只到 ±85.05°，会导致极区无 globe tile）
const TERRAIN_URL =
  'https://tiles.arcgis.com/tiles/HDgMIJDCbHtnomY9/arcgis/rest/services/Terrain_3D_GCSv2/ImageServer'

// 缓存地形 Provider
let cachedTerrain: Cesium.TerrainProvider | null = null
let terrainLoading: Promise<Cesium.TerrainProvider> | null = null
function getTerrainProvider(): Promise<Cesium.TerrainProvider> {
  if (cachedTerrain) return Promise.resolve(cachedTerrain)
  if (!terrainLoading) {
    terrainLoading = Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_URL).then((p) => {
      cachedTerrain = p
      return p
    })
  }
  return terrainLoading
}

// 相机限制
const MIN_ZOOM = 20
const MAX_ZOOM = 25000000
const MIN_PITCH = Cesium.Math.toRadians(-89.9)
const MAX_PITCH = Cesium.Math.toRadians(0)

// 交互参数（命名常量，避免魔法数字）
const WHEEL_ZOOM_OUT_FACTOR = 1.25 // 滚轮上滑放大倍率
const WHEEL_ZOOM_IN_FACTOR = 0.8 // 滚轮下滑缩小倍率
const AUTO_ROTATE_IDLE_MS = 3000 // 无交互多久后开始自动环绕
const AUTO_ROTATE_STEP_RAD = 0.0012 // 自动环绕每帧经度增量（东西向）
const ZOOM_EASE = 0.25 // 滚轮缩放每帧缓动系数（越大越快）
const SSE_ZOOMING = 2 // 缩放中瓦片清晰度（沿用 Cesium 默认精度，避免低清瓦片被放大）
const SSE_SETTLED = 1 // 稳定后瓦片清晰度（高分屏下与 Map Viewer 的清晰观感对齐）
// 高分屏按物理像素渲染后，SSE=2 在中近距离仍会少选 1~2 级瓦片；稳定后统一用 1
const sseForHeight = (): number => SSE_SETTLED

// 检测 WebGL 是否可用；在 jsdom 测试环境下返回 true，避免误判为不可用
function webglAvailable(): boolean {
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
const DOUBLE_CLICK_ZOOM_RATIO = 0.5 // 双击 zoom in 到当前高度的一半

/**
 * requestRenderMode 下，异步数据或命令式场景变更不会持续驱动渲染循环。
 * 每次真正改变场景时只请求一帧；交互动画则由 onCameraFrame 续请求下一帧。
 */
function requestSceneRender(v: Cesium.Viewer) {
  if (!v.isDestroyed()) v.scene.requestRender()
}

function setScreenSpaceError(globe: Cesium.Globe, value: number) {
  if (globe.maximumScreenSpaceError !== value) globe.maximumScreenSpaceError = value
}

// 点要素聚合：大量点合并为少量聚合点，降低渲染量
function enablePointClustering(ds: Cesium.DataSource) {
  const c = (ds as { clustering?: { enabled: boolean; pixelRange: number; minimumClusterSize: number; clusterBillboards: boolean } }).clustering
  if (!c) return
  c.enabled = true
  c.pixelRange = 20
  c.minimumClusterSize = 2
  c.clusterBillboards = true
}

/** 防抖：相机移动结束后等待 ms 再触发，避免快速缩放/拖动时视口查询风暴 */
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined
  return ((...args: unknown[]) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

/** 将服务 fullExtent 重投影到 4326 */
function reprojectExtent(e: { west: number; south: number; east: number; north: number; wkid: number }) {
  if (e.wkid === 4326 || e.wkid === 4269) return e
  try {
    const [w, s] = reprojectCoordinates([e.west, e.south], 'EPSG:' + e.wkid, 'EPSG:4326') as [number, number]
    const [ea, n] = reprojectCoordinates([e.east, e.north], 'EPSG:' + e.wkid, 'EPSG:4326') as [number, number]
    if ([w, s, ea, n].every(Number.isFinite)) return { west: w, south: s, east: ea, north: n, wkid: 4326 }
  } catch { /* 重投影失败保留原范围 */ }
  return e
}
function envContainsForFlight(env: { west: number; south: number; east: number; north: number }, ext: { west: number; south: number; east: number; north: number }): boolean {
  return !(env.east < ext.west || env.west > ext.east || env.north < ext.south || env.south > ext.north)
}
const EVENT_LAYER_MAX = 800
const REF_LAYER_MAX = 150

/** 区划/参考层风格：只描边，透明填充，避免盖住事件层 */
function referenceStyleFn(renderer?: Record<string, unknown> | null): ((props?: Record<string, unknown>) => FeatureStyleSpec | undefined) {
  const base = rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
  return (props?: Record<string, unknown>) => {
    const s = base(props)
    if (!s) return undefined
    return { ...s, fill: [0, 0, 0, 0] }
  }
}

// ---- 从 Web Map / Web Scene JSON 解析"初始相机"（ArcGIS viewpoint） ----
// 相位：position 常为 3857 投影（x/y 为米），需反投影到 lon/lat；heading 为方位角(度)，tilt 为自天顶倾角(0=俯视)。
function positionToCartesian(pos: Record<string, unknown> | undefined): Cesium.Cartesian3 | null {
  if (!pos) return null
  const x = Number(pos.x)
  const y = Number(pos.y)
  const z = Number(pos.z ?? 0)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const sr = pos.spatialReference as { wkid?: number; latestWkid?: number } | undefined
  const wkid = sr?.wkid ?? sr?.latestWkid
  if (wkid === 3857 || wkid === 102100 || wkid === 102113) {
    try {
      const [lon, lat] = reprojectCoordinates([x, y], 'EPSG:3857', 'EPSG:4326') as [number, number]
      return Cesium.Cartesian3.fromDegrees(lon, lat, z)
    } catch {
      return Cesium.Cartesian3.fromDegrees(x, y, z)
    }
  }
  // 4326 或缺省：x=lon(度), y=lat(度)
  return Cesium.Cartesian3.fromDegrees(x, y, z)
}

export function viewpointCameraFromWebmap(wm: Record<string, unknown> | undefined): { destination: Cesium.Cartesian3; orientation: { heading: number; pitch: number; roll: number } } | null {
  if (!wm) return null
  const initialState = wm.initialState as Record<string, unknown> | undefined
  const vp = ((wm.viewpoint ?? initialState?.viewpoint) as { camera?: { position?: Record<string, unknown>; heading?: number; tilt?: number } } | undefined)
  const cam = vp?.camera
  if (!cam?.position) return null
  const destination = positionToCartesian(cam.position as Record<string, unknown>)
  if (!destination) return null
  const heading = Cesium.Math.toRadians(cam.heading ?? 0)
  // tilt: 0=俯视(向下)，90=水平；Cesium pitch: -90=俯视，0=水平 → pitch = tilt - 90
  const pitch = Cesium.Math.toRadians((cam.tilt ?? 0) - 90)
  return { destination, orientation: { heading, pitch, roll: 0 } }
}

const VIEWPORT_FALLBACK = { west: -180, south: -90, east: 180, north: 90 }

export function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const added = useAppStore((s) => s.added)
  const theme = useAppStore((s) => s.theme)
  const effects = useAppStore((s) => s.effects)
  const effectsRef = useRef(effects)
  effectsRef.current = effects
  const autoRotateWakeRef = useRef<() => void>(() => {})
  const setLayerError = useLayerError()
  const clearLayerError = useClearLayerError()
  const layerMapRef = useRef<Map<string, { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[]; prims: unknown[]; vec: ArcGisVectorTileImageryProvider[]; flew: boolean; abort?: AbortController; viewportController?: { update(env: { west: number; south: number; east: number; north: number }): Promise<void>; dispose(): void }; cameraMoveHandler?: () => void }>>(new Map())
  const [glError, setGlError] = useState<string>('')
  const [layerNote, setLayerNote] = useState<string>('')

  // 创建 viewer（仅一次）
  useEffect(() => {
    const el = containerRef.current
    if (!el || viewerRef.current) return
    // E2E 测试模式：headless CI 的软件渲染 WebGL 极慢，UI 交互测试不需要球 → 跳过 Cesium Viewer
    if ((window as unknown as { __E2E__?: boolean }).__E2E__) return
    if (!webglAvailable()) {
      setGlError('\u5f53\u524d\u6d4f\u89c8\u5668\u65e0\u6cd5\u521b\u5efa WebGL\uff0c\u5730\u7403\u65e0\u6cd5\u6e32\u67d3\u3002\u8bf7\u4f7f\u7528\u5f00\u542f\u786c\u4ef6\u52a0\u901f\u7684 Chrome/Edge \u8bbf\u95ee\uff08Codex\u5185\u7f6e\u6d4f\u89c8\u5668 / \u65e0 GPU \u73af\u5883\u4e0d\u652f\u6301\uff09')
      return
    }
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
      setGlError('地球初始化失败：' + String(e).slice(0, 120))
      return
    }
    viewerRef.current = v
    registerViewer(v)
    // WebGL 上下文丢失预案（内存不足/卡死时不白屏：易加载并提示）
    const onCtxLost = (e: Event) => { e.preventDefault(); setGlError('WebGL 上下文已丢失（可能内存不足，正在尝试恢复…）') }
    const onCtxRestored = () => {
      setGlError('')
      requestSceneRender(v)
    }
    v.scene.canvas.addEventListener('webglcontextlost', onCtxLost)
    v.scene.canvas.addEventListener('webglcontextrestored', onCtxRestored)
    // Defer the final redraw out of the current frame so requestRenderMode
    // does not swallow the render after the last tile arrives.
    const onTileLoadProgress = (remaining: number) => {
      if (remaining > 0) {
        requestSceneRender(v)
        return
      }
      window.setTimeout(() => {
        if (!v.isDestroyed()) requestSceneRender(v)
      }, 0)
    }
    v.scene.globe.tileLoadProgressEvent.addEventListener(onTileLoadProgress)
    // 首次进入：加载完成后自动居中到用户大概位置
    void flyToHome(v)
    // 关闭 Bloom 泛光（移除图层发光高亮）
    v.scene.postProcessStages.bloom.enabled = false
    // 球体基色：图层加载间隙用深色，避免露蓝
    v.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1526')
    ;(window as unknown as { __evViewer: Cesium.Viewer; __Cesium: typeof Cesium }).__evViewer = v
    ;(window as unknown as { __Cesium: typeof Cesium }).__Cesium = Cesium

    // 相机控制 + 平滑缩放 + 倾斜钳制
    const scc = v.scene.screenSpaceCameraController
    scc.tiltEventTypes = Cesium.CameraEventType.RIGHT_DRAG
    scc.zoomEventTypes = [Cesium.CameraEventType.PINCH]
    scc.minimumZoomDistance = MIN_ZOOM
    scc.maximumZoomDistance = MAX_ZOOM

    const cancelFlight = () => {
      try {
        const c = v.camera as unknown as { _currentFlight?: unknown }
        if (c._currentFlight) v.camera.cancelFlight()
      } catch {
        // 忽略
      }
    }

    let targetH = v.camera.positionCartographic.height
    let settledFrames = 0
    let lastWheel = -1e9
    let lastInteract = 0
    let autoRotateWakeTimer: ReturnType<typeof setTimeout> | undefined

    const scheduleAutoRotateWake = () => {
      if (autoRotateWakeTimer !== undefined) clearTimeout(autoRotateWakeTimer)
      autoRotateWakeTimer = undefined
      if (!effectsRef.current.autoRotate || v.isDestroyed()) return
      const elapsed = performance.now() - lastInteract
      const delay = Math.max(0, AUTO_ROTATE_IDLE_MS - elapsed)
      autoRotateWakeTimer = setTimeout(() => {
        autoRotateWakeTimer = undefined
        if (effectsRef.current.autoRotate && !v.isDestroyed()) requestSceneRender(v)
      }, delay)
    }
    autoRotateWakeRef.current = scheduleAutoRotateWake

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelFlight()
      const h = v.camera.positionCartographic.height
      const factor = e.deltaY > 0 ? WHEEL_ZOOM_OUT_FACTOR : WHEEL_ZOOM_IN_FACTOR
      let min = MIN_ZOOM
      const gh = v.scene.globe.getHeight(v.camera.positionCartographic)
      if (gh !== undefined) min = Math.max(min, gh + 20)
      targetH = Math.max(min, Math.min(MAX_ZOOM, h * factor))
      lastWheel = performance.now()
      lastInteract = performance.now()
      scheduleAutoRotateWake()
      requestSceneRender(v)
    }
    v.scene.canvas.addEventListener('wheel', onWheel, { passive: false })

    const onCameraFrame = () => {
      const c = v.camera
      let needsNextFrame = false
      // 自动旋转（无交互 3 秒后、且非飞行中）—— setView 递增经度，沿东西方向绕地球转
      if (effectsRef.current.autoRotate && performance.now() - lastInteract > AUTO_ROTATE_IDLE_MS) {
        const fl = c as unknown as { _currentFlight?: unknown }
        if (!fl._currentFlight) {
          // 自动旋转：沿东西方向绕地球转（经度递增，保持纬度/高度/朝向不变）
          const carto = c.positionCartographic
          c.setView({
            destination: Cesium.Cartesian3.fromRadians(
              carto.longitude + AUTO_ROTATE_STEP_RAD,
              carto.latitude,
              carto.height,
            ),
            orientation: { heading: c.heading, pitch: c.pitch, roll: c.roll },
          })
          needsNextFrame = true
        }
      }
      if (c.pitch < MIN_PITCH || c.pitch > MAX_PITCH) {
        c.setView({
          destination: c.position,
          orientation: {
            heading: c.heading,
            pitch: Math.max(MIN_PITCH, Math.min(MAX_PITCH, c.pitch)),
            roll: c.roll,
          },
        })
        needsNextFrame = true
      }
      const h = c.positionCartographic.height
      const diff = h - targetH
      const wheelActive = performance.now() - lastWheel < 1500
      if (wheelActive) {
        if (Math.abs(diff) > 1) {
          c.moveForward(diff * ZOOM_EASE)
        }
        if (Math.abs(diff) > h * 0.005) {
          settledFrames = 0
          setScreenSpaceError(v.scene.globe, SSE_ZOOMING)
        } else {
          settledFrames++
          // 缩放刚停就尽快回到该高度的常规精度，避免"停止后仍糊很久"
          if (settledFrames > 2) {
            setScreenSpaceError(v.scene.globe, sseForHeight())
          }
        }
        needsNextFrame = true
      } else {
        targetH = h
        setScreenSpaceError(v.scene.globe, sseForHeight())
      }
      if (needsNextFrame) requestSceneRender(v)
    }
    v.scene.postUpdate.addEventListener(onCameraFrame)
    v.scene.globe.tileCacheSize = 100
    v.scene.globe.preloadSiblings = false

    // 按下鼠标（左/右/中）→ 取消飞行 + 关闭缓动缩放窗口
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    const onUserGrab = () => {
      cancelFlight()
      lastWheel = -1e9
      lastInteract = performance.now()
      scheduleAutoRotateWake()
      requestSceneRender(v)
    }
    handler.setInputAction(onUserGrab, Cesium.ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction(onUserGrab, Cesium.ScreenSpaceEventType.RIGHT_DOWN)
    handler.setInputAction(onUserGrab, Cesium.ScreenSpaceEventType.MIDDLE_DOWN)
    // 双击 → zoom in
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      const picked = v.camera.pickEllipsoid(movement.position, v.scene.globe.ellipsoid)
      if (!picked) return
      const carto = v.scene.globe.ellipsoid.cartesianToCartographic(picked)
      const curH = v.camera.positionCartographic.height
      const targetH2 = Math.max(MIN_ZOOM * 2, curH * DOUBLE_CLICK_ZOOM_RATIO)
      v.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
          targetH2
        ),
        orientation: { heading: v.camera.heading, pitch: v.camera.pitch, roll: 0 },
      })
      requestSceneRender(v)
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

    // 真实地形始终开启（缓存 Provider + 光照阴影）
    getTerrainProvider().then((p) => {
      if (v.isDestroyed()) return
      v.terrainProvider = p
      requestSceneRender(v)
    })

    return () => {
      v.scene.canvas.removeEventListener('wheel', onWheel)
      v.scene.canvas.removeEventListener('webglcontextlost', onCtxLost)
      v.scene.canvas.removeEventListener('webglcontextrestored', onCtxRestored)
      v.scene.globe.tileLoadProgressEvent.removeEventListener(onTileLoadProgress)
      v.scene.postUpdate.removeEventListener(onCameraFrame)
      if (autoRotateWakeTimer !== undefined) clearTimeout(autoRotateWakeTimer)
      autoRotateWakeRef.current = () => {}
      handler.destroy()
      unregisterViewer()
      v.destroy()
      viewerRef.current = null
    }
  }, [])

  // 场景级效果：大气 / 星空 / 太阳月亮 / 雾 / 昼夜 / 夸张 / 半透明
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    const scene = v.scene
    const globe = scene.globe
    globe.showGroundAtmosphere = effects.atmosphere
    // 背景与星空跟随主题：白天白底（无星空），深色深空（可选星空）
    const dark = theme === 'dark'
    // 与 theme.css 中的 --globe-bg 保持一致；直接由主题状态决定，避免读取 data-theme 时序造成旧主题背景闪回。
    scene.backgroundColor = Cesium.Color.fromCssColorString(dark ? '#05070d' : '#ffffff')
    if (scene.skyBox) scene.skyBox.show = dark && effects.stars
    if (scene.sun) scene.sun.show = effects.sunMoon
    if (scene.moon) scene.moon.show = effects.sunMoon
    scene.fog.enabled = effects.fog
    globe.enableLighting = effects.dayNight
    scene.verticalExaggeration = effects.terrainExaggeration
    if (globe.translucency) {
      globe.translucency.enabled = effects.globeTranslucency
      // Cesium 的 frontFaceAlpha/backFaceAlpha 默认 1（完全不透明），需显式调低才有半透明效果
      globe.translucency.frontFaceAlpha = effects.globeTranslucency ? effects.translucencyAlpha : 1
      globe.translucency.backFaceAlpha = effects.globeTranslucency
        ? Math.min(1, effects.translucencyAlpha + 0.1)
        : 1
    }
    autoRotateWakeRef.current()
    requestSceneRender(v)
  }, [effects, theme])

  // 图层管理（增量式）：底图常驻，只增删各 Web Map 的操作图层 → 不重建不闪蓝
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    let cancelled = false
    const layers = v.imageryLayers

    // 底图常驻：仅首次添加
    if (layers.length === 0) {
      // 底图：WGS84(4326) World Imagery，覆盖 ±90°，与官方 Imagery Hybrid (WGS84) 一致
      layers.add(
        new Cesium.ImageryLayer(
          new Cesium.UrlTemplateImageryProvider({
            url: WORLD_IMAGERY_WGS84_TILES,
            tilingScheme: new Cesium.GeographicTilingScheme(),
            maximumLevel: 22,
          })
        ),
        0
      )
      // 矢量标注：官方 Hybrid Reference Layer 样式，Web Mercator 瓦片，全英文地名
      const labelProvider = new ArcGisVectorTileImageryProvider({
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
      })
      labelProvider.readyPromise
        .then(() => {
          if (v.isDestroyed()) {
            labelProvider.destroy()
            return
          }
          layers.add(new Cesium.ImageryLayer(labelProvider as unknown as Cesium.ImageryProvider))
          requestSceneRender(v)
        })
        .catch((e: unknown) => {
          console.error('[globe] 矢量标注样式加载失败', e)
          labelProvider.destroy()
        })
      requestSceneRender(v)
    }

    // 移除已删除的 Web Map 图层
    let removedLayer = false
    for (const [id, rec] of layerMapRef.current) {
      if (!added.some((a) => a.id === id)) {
        rec.abort?.abort()
        if (rec.cameraMoveHandler) (v.camera.moveEnd as unknown as { removeEventListener?: (h: () => void) => void } | undefined)?.removeEventListener?.(rec.cameraMoveHandler)
        rec.viewportController?.dispose()
        rec.layers.forEach((l) => layers.remove(l, true))
        rec.vec.forEach((p) => p.destroy())
        rec.ds.forEach((d) => v.dataSources.remove(d, true))
        if (v.scene.primitives) rec.prims.forEach((p) => (v.scene.primitives as unknown as { remove: (x: unknown, y?: boolean) => void }).remove(p, true))
        layerMapRef.current.delete(id)
        removedLayer = true
      }
    }
    if (removedLayer) requestSceneRender(v)


    // 渲染新增的 Web Map 操作图层（异步：需探测图层坐标系以匹配 tilingScheme）
    const renderOperationalLayers = async (
      v: Cesium.Viewer,
      a: (typeof added)[number],
      rec: { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[]; prims: unknown[]; vec: ArcGisVectorTileImageryProvider[]; flew: boolean; abort?: AbortController; viewportController?: { update(env: { west: number; south: number; east: number; north: number }): Promise<void>; dispose(): void }; cameraMoveHandler?: () => void },
    ) => {
      const wm = a.webmap as Record<string, unknown> | undefined
      if (!wm) return
      const skippedBusiness = skippedBusinessLayers(wm)
      if (skippedBusiness > 0) setLayerNote(`此地图含多个业务图层，仅渲染前 ${MAX_BUSINESS_LAYERS} 个（略过 ${skippedBusiness} 个）`)
      const keepAlive = () => !cancelled && !v.isDestroyed() && added.some((x) => x.id === a.id)
      const signal = rec.abort?.signal
      const budget: { remaining: number } = { remaining: SAFETY.MAX_TOTAL_FEATURES }
      // 预算/降级：业务层要素合计超预算则跳过；单层超 MAX_RENDER_FEATURES 则截断，防 OOM/阻塞
      const consumeBudget = (gj: unknown): { data: unknown; capped: boolean } | null => {
        // ① 顶点预算：先抽稀再截断（防单个大 polygon 内存爆炸）
        const raw = gj as { type?: string; features?: Record<string, unknown>[] } | null
        const features = Array.isArray(raw?.features) ? raw.features : []
        const vb = applyVertexBudget({ type: 'FeatureCollection', features }, SAFETY.MAX_RENDER_VERTICES)
        // ② 要素数预算：再限制对象个数
        const r = consumeFeatureBudget(budget.remaining, vb.data, SAFETY.MAX_RENDER_FEATURES)
        if (!r) return null
        budget.remaining = r.remaining
        return { data: r.data, capped: vb.capped || r.capped }
      }
      // 相机优先：Web Map/Scene 自带初始相机 → 飞相机；否则回退到"程序初始位置"
      if (!rec.flew) {
        rec.flew = true
        const cam = viewpointCameraFromWebmap(wm)
        if (cam) {
          try {
            v.camera.flyTo(cam)
            requestSceneRender(v)
          } catch {
            // ignore
          }
        } else {
          void flyToHome(v)
        }
      }
      for (const op of renderableLayersFromWebmap(wm)) {
        if (op.visibility === false) continue
        const img = await providerForWebLayer(op)
        if (cancelled || v.isDestroyed()) return
        if (img) {
          const il = new Cesium.ImageryLayer(img)
          if (typeof op.opacity === 'number') il.alpha = op.opacity
          rec.layers.push(il)
          layers.add(il)
          requestSceneRender(v)
        } else if (isVectorTileLayer(op)) {
          // 方案 A：MapLibre GL 按 ArcGIS 官方样式渲染矢量瓦片 → Cesium ImageryProvider
          // （不再用 MVTDataProvider 裸几何渲染，也不再降级 OSM 栅格；样式与 ArcGIS Map Viewer 一致）
          const provider = new ArcGisVectorTileImageryProvider({
            styleUrl: op.styleUrl,
            url: op.url,
            title: op.title,
            signal,
          })
          provider.readyPromise
            .then(() => {
              if (!keepAlive()) {
                provider.destroy()
                return
              }
              const il = new Cesium.ImageryLayer(provider as unknown as Cesium.ImageryProvider)
              if (typeof op.opacity === 'number') il.alpha = op.opacity
              rec.layers.push(il)
              rec.vec.push(provider)
              layers.add(il)
              requestSceneRender(v)
              clearLayerError(a.id)
            })
            .catch((e: unknown) => {
              console.error('[layer] 矢量瓦片样式渲染失败', op.url || op.styleUrl, e)
              provider.destroy()
              setLayerError(a.id, '矢量瓦片渲染失败：' + (op.title || op.url || op.styleUrl))
            })
        } else if (isFeatureCollectionLayer(op)) {
          // 内嵌 FeatureCollection（layerDefinition.featureCollection）：走 Worker 预算管线，防大内嵌数据集卡死
          const fc = (op.layerDefinition as { featureCollection?: unknown } | undefined)?.featureCollection
          const realFc = (fc as { featureCollection?: unknown } | undefined)?.featureCollection ?? fc
          if (!realFc) { setLayerError(a.id, '内嵌要素集为空'); continue }
          runViewportProcess({ geojson: realFc, maxVertices: SAFETY.MAX_RENDER_VERTICES, maxFeatures: SAFETY.MAX_RENDER_FEATURES })
            .then((res) => {
              if (res.capped) setLayerNote('内嵌数据量大，已按顶点/要素预算降级')
              return Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features: res.features } as never)
            })
            .then((ds) => {
              if (!keepAlive() || !ds) return
              enablePointClustering(ds as Cesium.DataSource)
              v.dataSources.add(ds)
              rec.ds.push(ds)
              requestSceneRender(v)
              clearLayerError(a.id)
            })
            .catch((e) => {
              console.error('[layer] 内嵌要素集加载失败', op.title || op.url, e)
              setLayerError(a.id, '内嵌要素集加载失败：' + (op.title || op.url))
            })
        } else if (op.url) {
          if (isSceneLayer(op)) {
            // ArcGIS SceneServer / I3S 3D 场景
            loadI3S(op.url)
              .then((prim) => {
                if (!keepAlive() || !prim) return
                v.scene.primitives.add(prim)
                rec.prims.push(prim)
                requestSceneRender(v)
                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] 3D 场景加载失败', op.url, e)
                setLayerError(a.id, '3D 场景加载失败：' + (op.title || op.url))
              })
          } else if (is3dTilesLayer(op)) {
            // OGC 3D Tiles
            load3DTiles(op.url)
              .then((tileset) => {
                if (!keepAlive() || !tileset) return
                v.scene.primitives.add(tileset)
                rec.prims.push(tileset)
                requestSceneRender(v)
                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] 3D Tiles 加载失败', op.url, e)
                setLayerError(a.id, '3D Tiles 加载失败：' + (op.title || op.url))
              })
          } else if (isWfsLayer(op)) {
            // WFS / OGC API Features：通过协议适配器读取 GeoJSON
            fetchOgcFeatureGeoJSON(op.url, op, signal)
              .then((gj) => {
                if (cancelled || v.isDestroyed()) return undefined
                return runViewportProcess({ geojson: gj, maxVertices: SAFETY.MAX_RENDER_VERTICES, maxFeatures: SAFETY.MAX_RENDER_FEATURES })
                  .then((res) => {
                    if (res.capped) setLayerNote('数据量大，已按顶点/要素预算降级')
                    const b = consumeBudget({ type: 'FeatureCollection', features: res.features })
                    if (!b) { setLayerNote('数据总量过大，已省略部分图层'); return undefined }
                    if (b.capped) setLayerNote('数据量大，仅显示部分要素')
                    return Cesium.GeoJsonDataSource.load(b.data as never)
                  })
              })
              .then((ds) => {
                if (!keepAlive() || !ds) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)
                requestSceneRender(v)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] WFS/OGC 要素图层加载失败', op.url, e)
                setLayerError(a.id, 'WFS/OGC 要素图层加载失败：' + (op.title || op.url))
              })
          } else if (isCsvLayer(op)) {
            // CSV：按位置字段转换为点 GeoJSON
            fetchCsvGeoJSON(op.url, op, signal)
              .then((gj) => {
                if (cancelled || v.isDestroyed()) return undefined
                return runViewportProcess({ geojson: gj, maxVertices: SAFETY.MAX_RENDER_VERTICES, maxFeatures: SAFETY.MAX_RENDER_FEATURES })
                  .then((res) => {
                    if (res.capped) setLayerNote('数据量大，已按顶点/要素预算降级')
                    const b = consumeBudget({ type: 'FeatureCollection', features: res.features })
                    if (!b) { setLayerNote('数据总量过大，已省略部分图层'); return undefined }
                    if (b.capped) setLayerNote('数据量大，仅显示部分要素')
                    return Cesium.GeoJsonDataSource.load(b.data as never)
                  })
              })
              .then((ds) => {
                if (!keepAlive() || !ds) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)
                requestSceneRender(v)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] CSV 图层加载失败', op.url, e)
                setLayerError(a.id, 'CSV 图层加载失败：' + (op.title || op.url))
              })
          } else if (isFeatureLayer(op)) {
            // 视口驱动：解析服务全部可查询层（多层叠加：区划层描边 + 事件层分色），自动飞到数据范围，每层独立预算防卡死
            const env0 = viewEnvelopeFromCamera(v.scene.camera as never) ?? VIEWPORT_FALLBACK
            resolveFeatureService(op.url as string)
              .then((svc) => {
                if (cancelled || v.isDestroyed()) return undefined
                const ext = svc.extent ? reprojectExtent(svc.extent) : undefined
                if (ext && !envContainsForFlight(env0, ext)) {
                  try {
                    v.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(ext.west, ext.south, ext.east, ext.north) })
                    requestSceneRender(v)
                  } catch { /* 飞行失败忽略 */ }
                }
                const layerBases = svc.layers
                if (layerBases.length <= 1) {
                  const base = layerBases[0] ?? (op.url as string)
                  return Promise.all([fetchFeatureStyle(base), fetchFeatureRenderer(base)]).then(async ([style, renderer]) => {
                    if (cancelled || v.isDestroyed()) return undefined
                    const rendererType = String((renderer as Record<string, unknown> | null)?.type ?? '')
                    const hasRendererStyle = !!renderer && ['simple', 'uniqueValue', 'classBreaks'].includes(rendererType)
                    if (hasPrimitiveRendering() && !hasRendererStyle) {
                      try {
                        const base2 = await resolveFeatureQueryBase(op.url as string)
                        const ctl = createViewportController(v.scene, v.scene.primitives, { serviceUrl: base2, maxFeatures: SAFETY.MAX_FEATURES })
                        rec.viewportController = ctl
                        const updateViewport = () =>
                          ctl.update(viewEnvelopeFromCamera(v.scene.camera as never) ?? VIEWPORT_FALLBACK)
                            .finally(() => requestSceneRender(v))
                        const handler = debounce(() => void updateViewport(), 250)
                        rec.cameraMoveHandler = handler
                        const moveEnd = (v.camera.moveEnd as unknown as { addEventListener?: (h: () => void) => void } | undefined)
                        moveEnd?.addEventListener?.(handler)
                        void updateViewport()
                        clearLayerError(a.id)
                        return null
                      } catch (e) {
                        console.error('[layer] Primitive 渲染失败，回退 GeoJSON', op.url, e)
                        return Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features: [] } as never)
                      }
                    }
                    const styleFn = rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
                    return queryViewportData(base, env0, { maxFeatures: SAFETY.MAX_RENDER_FEATURES, outFields: '*' }, signal).then((res) => {
                      if (cancelled || v.isDestroyed()) return undefined
                      if (res.capped) setLayerNote('数据量大，已按视口/预算降级显示')
                      return Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features: res.features } as never, style ? { markerColor: style.markerColor, markerSize: style.markerSize, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill } : undefined).then((ds) => {
                        applyFeatureStyler(ds as never, styleFn)
                        enablePointClustering(ds as Cesium.DataSource)
                        return ds
                      })
                    })
                  })
                }
                // 分层：区划层(simple)仅描边参考，事件层(unique/classBreaks)填充分色且只渲染一个汇总层，每层独立预算不互相挤占
                const makeLayer = (base: string) => Promise.all([fetchFeatureStyle(base), fetchFeatureRenderer(base)]).then(([style, renderer]) => {
                  if (cancelled || v.isDestroyed()) return null
                  const rt = String((renderer as Record<string, unknown> | null)?.type ?? '')
                  const isRef = rt === 'simple'
                  // 区划/参考层（simple）可用开关控制：关闭时不渲染，开启时用低预算描边（避免盖住事件层且不卡主线程）
                  if (isRef && !(effectsRef.current?.showReferenceLayers ?? true)) return null
                  const maxFeatures = isRef ? REF_LAYER_MAX : EVENT_LAYER_MAX
                  const styleFn = isRef ? referenceStyleFn(renderer) : rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
                  return queryViewportData(base, env0, { maxFeatures, outFields: '*' }, signal).then((res) => {
                    if (cancelled || v.isDestroyed()) return null
                    if (res.capped) setLayerNote('数据量大，已按视口/预算降级显示')
                    if (res.features.length === 0) return null
                    return Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features: res.features } as never, style ? { markerColor: style.markerColor, markerSize: style.markerSize, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill } : undefined).then((ds) => {
                      applyFeatureStyler(ds as never, styleFn)
                      return ds
                    })
                  })
                })
                return Promise.all(layerBases.map(makeLayer)).then((dsList) => {
                  if (cancelled || v.isDestroyed()) return null
                  for (const ds of dsList) {
                    if (!ds) continue
                    enablePointClustering(ds as Cesium.DataSource)
                    v.dataSources.add(ds as Cesium.DataSource)
                    rec.ds.push(ds as Cesium.DataSource)
                    requestSceneRender(v)
                  }
                  clearLayerError(a.id)
                  return null
                })
              })
              .then((ds) => {
                if (ds === null) return
                if (!ds) return
                if (!keepAlive()) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds as Cesium.DataSource)
                rec.ds.push(ds as Cesium.DataSource)
                requestSceneRender(v)
                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] Feature 图层加载失败', op.url, e)
                setLayerError(a.id, '要素图层加载失败：' + (op.title || op.url))
              })
          } else if (isGeoJsonLayer(op)) {
            try { await assertUrlWithinLimit(op.url, SAFETY.MAX_FILE_BYTES) } catch (e) { console.error('[layer] GeoJSON \u8fc7\u5927', op.url, e); setLayerError(a.id, 'GeoJSON \u6587\u4ef6\u8fc7\u5927\uff0c\u5df2\u9650\u5236\u52a0\u8f7d'); continue }
            fetch(op.url, { signal: withFetchTimeout(signal) })
              .then((r) => r.json().catch(() => null))
              .then((json) => {
                if (cancelled || v.isDestroyed()) return undefined
                return runViewportProcess({ geojson: json }).then((res) => {
                  if (res.capped) setLayerNote('文件数据量大，已按顶点预算降级显示')
                  return Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features: res.features } as never)
                })
              })
              .then((ds) => {
                if (!keepAlive() || !ds) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)
                requestSceneRender(v)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] GeoJSON 图层加载失败', op.url, e)
                setLayerError(a.id, 'GeoJSON 图层加载失败：' + (op.title || op.url))
              })
          } else if (isKmlLayer(op)) {
            const kmlUrl = op.url as string
            try { await assertUrlWithinLimit(kmlUrl, SAFETY.KML_MAX_BYTES) } catch (e) { console.error('[layer] KML \u8fc7\u5927', kmlUrl, e); setLayerError(a.id, 'KML \u6587\u4ef6\u8fc7\u5927\uff0c\u5df2\u9650\u5236\u52a0\u8f7d'); continue }
            // KML \u2192 GeoJSON \u2192 Worker \u9876\u70b9/\u8981\u7d20\u9884\u7b97\uff1a\u80fd\u89e3\u6790\u51fa\u8981\u7d20\u7684\u8d70\u9884\u7b97\u7ba1\u7ebf\uff0c\u5426\u5219\u56de\u9000\u539f\u751f KmlDataSource.load\uff08\u4fdd\u7559\u56fe\u6807/\u6837\u5f0f\uff09\u3002
            const kmlStyleFn = (props?: Record<string, unknown>) => kmlStyleToFeatureStyle((props?.kmlStyle ?? undefined) as KmlStyleSpec | undefined)
            Promise.resolve()
              .then(() => fetch(kmlUrl, { signal: withFetchTimeout(signal) }))
              .then((r) => r.text())
              .then((kmlText) => {
                const gj = parseKmlToGeoJSON(kmlText)
                if (gj.features.length === 0) throw new Error('no features')
                return runViewportProcess({ geojson: gj, maxVertices: SAFETY.MAX_RENDER_VERTICES, maxFeatures: SAFETY.MAX_RENDER_FEATURES })
                  .then((res) => {
                    if (res.capped) setLayerNote('KML \u6570\u636e\u91cf\u5927\uff0c\u5df2\u6309\u9876\u70b9/\u8981\u7d20\u9884\u7b97\u964d\u7ea7\u663e\u793a')
                    return Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features: res.features } as never)
                  })
              })
              .then((ds) => {
                if (!keepAlive() || !ds) return
                applyFeatureStyler(ds as never, kmlStyleFn)
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)
                requestSceneRender(v)
                clearLayerError(a.id)
              })
              .catch((e) => {
                console.warn('[layer] KML \u8f6c GeoJSON \u5931\u8d25\uff0c\u56de\u9000\u539f\u751f', kmlUrl, e)
                // \u56de\u9000\uff1a\u539f\u751f KML \u6e32\u67d3\uff08\u4fdd\u7559\u56fe\u6807/\u6837\u5f0f\uff09
                return Cesium.KmlDataSource.load(kmlUrl)
                  .then((ds) => {
                    if (!keepAlive() || !ds) return
                    v.dataSources.add(ds)
                    rec.ds.push(ds)
                    requestSceneRender(v)
                    clearLayerError(a.id)
                  })
                  .catch((e2) => {
                    console.error('[layer] KML \u56fe\u5c42\u52a0\u8f7d\u5931\u8d25', kmlUrl, e2)
                    setLayerError(a.id, 'KML \u56fe\u5c42\u52a0\u8f7d\u5931\u8d25\uff1a' + (op.title || kmlUrl))
                  })
              })
          }
        }
      }
    }

    // Serial render queue: load one web map at a time so heavy layers don't fight for the main thread.
    let renderQueue: Promise<unknown> = Promise.resolve()
    for (const a of added) {
      if (a.kind !== 'webmap' || !a.webmap || layerMapRef.current.has(a.id)) continue
      const rec: { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[]; prims: unknown[]; vec: ArcGisVectorTileImageryProvider[]; flew: boolean; abort?: AbortController; viewportController?: { update(env: { west: number; south: number; east: number; north: number }): Promise<void>; dispose(): void }; cameraMoveHandler?: () => void } = { layers: [], ds: [], prims: [], vec: [], flew: false, abort: new AbortController() }
      layerMapRef.current.set(a.id, rec)
      renderQueue = renderQueue
        .then(() => renderOperationalLayers(v, a, rec))
        .catch((e) => { console.error('[layer] webmap 渲染失败', a.id, e); setLayerError(a.id, '图层加载失败：' + (a.title || a.id)) })
    }

    return () => {
      cancelled = true
    }
  }, [added, setLayerError, clearLayerError])


  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {glError && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, padding: 24, textAlign: 'center', background: 'rgba(0,0,0,0.6)', zIndex: 10 }}>
          {glError}
        </div>
      )}
      {layerNote && (
        <div
          style={{ position: 'absolute', left: 12, bottom: 12, maxWidth: '70%', padding: '8px 12px', borderRadius: 8, background: 'rgba(20,24,32,0.85)', color: '#fff', fontSize: 13, zIndex: 9, pointerEvents: 'none' }}
          role="status"
        >
          {layerNote}
        </div>
      )}
    </div>
  )
}

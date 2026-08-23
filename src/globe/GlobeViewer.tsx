import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { useAppStore } from '../state/store'

const useLayerError = () => useAppStore((s) => s.setLayerError)
const useClearLayerError = () => useAppStore((s) => s.clearLayerError)
import { registerViewer, unregisterViewer, flyToHome } from './cameraApi'
import { renderableLayersFromWebmap } from './assess'
import { isGlobalVectorTileLayer, SAFETY, assertUrlWithinLimit } from './loadSafety'
import {
  providerForWebLayer,
  isFeatureLayer,
  isGeoJsonLayer,
  isKmlLayer,
  isVectorTileLayer,
  isSceneLayer,
  is3dTilesLayer,
  isWfsLayer,
  isCsvLayer,
  fetchFeatureGeoJSON,
  fetchFeatureStyle,
  fetchFeatureRenderer,
  WORLD_IMAGERY_TILES,
  WORLD_LABELS_TILES,
  WORLD_IMAGERY_WGS84_TILES,
} from './webmap'
import { reprojectFeatureCollection, detectServiceWkid, rendererToStyleFn, applyFeatureStyler, reprojectCoordinates } from './vector'
import { loadI3S, load3DTiles } from './scene'
import { fetchVectorTileTemplates, toCesiumMvtTemplate } from './vectorTile'
import { fetchOgcFeatureGeoJSON } from './ogc'
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
const SSE_ZOOMING = 4 // 缩放中瓦片清晰度（粗，保流畅）
const SSE_SETTLED = 2 // 稳定后瓦片清晰度（精细）
// 广域视图用更粗的瓦片（大 SSE），拉近后回到精细
const sseForHeight = (h: number): number => (h > 1_000_000 ? 16 : h > 200_000 ? 8 : SSE_SETTLED)

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

// 点要素聚合：大量点合并为少量聚合点，降低渲染量
function enablePointClustering(ds: Cesium.DataSource) {
  const c = (ds as { clustering?: { enabled: boolean; pixelRange: number; minimumClusterSize: number; clusterBillboards: boolean } }).clustering
  if (!c) return
  c.enabled = true
  c.pixelRange = 20
  c.minimumClusterSize = 2
  c.clusterBillboards = true
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

export function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const added = useAppStore((s) => s.added)
  const theme = useAppStore((s) => s.theme)
  const effects = useAppStore((s) => s.effects)
  const effectsRef = useRef(effects)
  effectsRef.current = effects
  const setLayerError = useLayerError()
  const clearLayerError = useClearLayerError()
  const layerMapRef = useRef<Map<string, { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[]; prims: unknown[]; flew: boolean }>>(new Map())
  const [glError, setGlError] = useState<string>('')

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
      })
    } catch (e) {
      console.error('[globe] 初始化失败', e)
      setGlError('地球初始化失败：' + String(e).slice(0, 120))
      return
    }
    viewerRef.current = v
    registerViewer(v)
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
    }
    v.scene.canvas.addEventListener('wheel', onWheel, { passive: false })

    let lastInteract = 0
    const onCameraFrame = () => {
      const c = v.camera
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
          v.scene.globe.maximumScreenSpaceError = SSE_ZOOMING
        } else {
          settledFrames++
          if (settledFrames > 8) {
            v.scene.globe.maximumScreenSpaceError = SSE_SETTLED
          }
        }
      } else {
        targetH = h
        v.scene.globe.maximumScreenSpaceError = sseForHeight(h)
      }
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
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

    // 真实地形始终开启（缓存 Provider + 光照阴影）
    getTerrainProvider().then((p) => {
      if (v.isDestroyed()) return
      v.terrainProvider = p
    })

    return () => {
      v.scene.canvas.removeEventListener('wheel', onWheel)
      v.scene.postUpdate.removeEventListener(onCameraFrame)
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
    scene.backgroundColor = Cesium.Color.fromCssColorString(dark ? '#05070d' : '#f4f5f7')
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
  }, [effects, theme])

  // 图层管理（增量式）：底图常驻，只增删各 Web Map 的操作图层 → 不重建不闪蓝
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    let cancelled = false
    const layers = v.imageryLayers

    // 底图常驻：仅首次添加
    if (layers.length === 0) {
      // 极区兜底：底层加 WGS84(4326) World Imagery，覆盖 ±90°（3857 版只到 ±85.05°）
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
      layers.add(new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({ url: WORLD_IMAGERY_TILES })))
      layers.add(new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({ url: WORLD_LABELS_TILES })))
    }

    // 移除已删除的 Web Map 图层
    for (const [id, rec] of layerMapRef.current) {
      if (!added.some((a) => a.id === id)) {
        rec.layers.forEach((l) => layers.remove(l, true))
        rec.ds.forEach((d) => v.dataSources.remove(d, true))
        if (v.scene.primitives) rec.prims.forEach((p) => (v.scene.primitives as unknown as { remove: (x: unknown, y?: boolean) => void }).remove(p, true))
        layerMapRef.current.delete(id)
      }
    }


    // 渲染新增的 Web Map 操作图层（异步：需探测图层坐标系以匹配 tilingScheme）
    const renderOperationalLayers = async (
      v: Cesium.Viewer,
      a: (typeof added)[number],
      rec: { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[]; prims: unknown[]; flew: boolean },
    ) => {
      const wm = a.webmap as Record<string, unknown> | undefined
      if (!wm) return
      const keepAlive = () => !cancelled && !v.isDestroyed() && added.some((x) => x.id === a.id)
      // 相机优先：Web Map/Scene 自带初始相机 → 飞相机；否则回退到"程序初始位置"
      if (!rec.flew) {
        rec.flew = true
        const cam = viewpointCameraFromWebmap(wm)
        if (cam) {
          try {
            v.camera.flyTo(cam)
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
        } else if (isVectorTileLayer(op)) {
          // OpenStreetMap vectortile basemap: global vector decode/render hangs -> fallback to OSM raster tiles
          if (isGlobalVectorTileLayer(op)) {
            const basemapRaster = /openstreetmap/i.test(op.title || '')
              ? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
              : /world street map|streets/i.test(op.title || '')
                ? 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'
                : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
            const osm = new Cesium.ImageryLayer(
              new Cesium.UrlTemplateImageryProvider({ url: basemapRaster })
            )
            rec.layers.push(osm)
            layers.add(osm)
            clearLayerError(a.id)
            continue
          }

          // VectorTileLayer 可能只有 styleUrl；从样式源解析全部 MVT 模板并交给 Cesium 动态切片。
          fetchVectorTileTemplates(op)
            .then((templates) => {
              if (templates.length === 0) throw new Error('未找到 VectorTile MVT 源')
              return Promise.all(
                templates.map((template) =>
                  Cesium.MVTDataProvider.fromUrl(toCesiumMvtTemplate(template), { minZoom: 0, maxZoom: SAFETY.VECTOR_TILE_MAX_ZOOM })
                )
              )
            })
            .then((providers) => {
              if (!keepAlive()) return
              providers.forEach((provider) => {
                v.scene.primitives.add(provider)
                rec.prims.push(provider)
              })
              clearLayerError(a.id)
            })
            .catch((e) => {
              console.error('[layer] 矢量瓦片加载失败', op.url || op.styleUrl, e)
              setLayerError(a.id, '矢量瓦片加载失败：' + (op.title || op.url || op.styleUrl))
            })
        } else if (op.url) {
          if (isSceneLayer(op)) {
            // ArcGIS SceneServer / I3S 3D 场景
            loadI3S(op.url)
              .then((prim) => {
                if (!keepAlive() || !prim) return
                v.scene.primitives.add(prim)
                rec.prims.push(prim)
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
                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] 3D Tiles 加载失败', op.url, e)
                setLayerError(a.id, '3D Tiles 加载失败：' + (op.title || op.url))
              })
          } else if (isWfsLayer(op)) {
            // WFS / OGC API Features：通过协议适配器读取 GeoJSON
            fetchOgcFeatureGeoJSON(op.url, op)
              .then((gj) => {
                if (cancelled || v.isDestroyed()) return undefined
                return Cesium.GeoJsonDataSource.load(gj as never)
              })
              .then((ds) => {
                if (!keepAlive() || !ds) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] WFS/OGC 要素图层加载失败', op.url, e)
                setLayerError(a.id, 'WFS/OGC 要素图层加载失败：' + (op.title || op.url))
              })
          } else if (isCsvLayer(op)) {
            // CSV：按位置字段转换为点 GeoJSON
            fetchCsvGeoJSON(op.url, op)
              .then((gj) => {
                if (cancelled || v.isDestroyed()) return undefined
                return Cesium.GeoJsonDataSource.load(gj as never)
              })
              .then((ds) => {
                if (!keepAlive() || !ds) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] CSV 图层加载失败', op.url, e)
                setLayerError(a.id, 'CSV 图层加载失败：' + (op.title || op.url))
              })
          } else if (isFeatureLayer(op)) {
            // 要素/WFS：拉取 GeoJSON + 符号样式 + 服务 wkid，再重投影到 WGS84，并按渲染器逐要素着色
            Promise.all([fetchFeatureGeoJSON(op.url), fetchFeatureStyle(op.url), detectServiceWkid(op.url), fetchFeatureRenderer(op.url)])
              .then(([gj, style, wkid, renderer]) => {
                if (cancelled || v.isDestroyed()) return undefined
                const data = reprojectFeatureCollection(gj as never, wkid)
                const styleFn = rendererToStyleFn((renderer ?? undefined) as Record<string, unknown> | undefined)
                return Cesium.GeoJsonDataSource.load(data as never, style
                  ? {
                      markerColor: style.markerColor,
                      markerSize: style.markerSize,
                      stroke: style.stroke,
                      strokeWidth: style.strokeWidth,
                      fill: style.fill,
                    }
                  : undefined)
                  .then((ds) => {
                    applyFeatureStyler(ds as never, styleFn)
                    enablePointClustering(ds as Cesium.DataSource)
                    return ds
                  })
              })
              .then((ds) => {
                if (!keepAlive() || !ds) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] Feature 图层加载失败', op.url, e)
                setLayerError(a.id, '要素图层加载失败：' + (op.title || op.url))
              })
          } else if (isGeoJsonLayer(op)) {
            try { await assertUrlWithinLimit(op.url, SAFETY.MAX_FILE_BYTES) } catch (e) { console.error('[layer] GeoJSON \u8fc7\u5927', op.url, e); setLayerError(a.id, 'GeoJSON \u6587\u4ef6\u8fc7\u5927\uff0c\u5df2\u9650\u5236\u52a0\u8f7d'); continue }
            Cesium.GeoJsonDataSource.load(op.url)
              .then((ds) => {
                if (!keepAlive()) return
                enablePointClustering(ds as Cesium.DataSource)
                v.dataSources.add(ds)
                rec.ds.push(ds)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] GeoJSON 图层加载失败', op.url, e)
                setLayerError(a.id, 'GeoJSON 图层加载失败：' + (op.title || op.url))
              })
          } else if (isKmlLayer(op)) {
            try { await assertUrlWithinLimit(op.url, SAFETY.MAX_FILE_BYTES) } catch (e) { console.error('[layer] KML \u8fc7\u5927', op.url, e); setLayerError(a.id, 'KML \u6587\u4ef6\u8fc7\u5927\uff0c\u5df2\u9650\u5236\u52a0\u8f7d'); continue }
            Cesium.KmlDataSource.load(op.url)
              .then((ds) => {
                if (!keepAlive()) return
                v.dataSources.add(ds)
                rec.ds.push(ds)

                clearLayerError(a.id)
              })
              .catch((e) => {
                console.error('[layer] KML 图层加载失败', op.url, e)
                setLayerError(a.id, 'KML 图层加载失败：' + (op.title || op.url))
              })
          }
        }
      }
    }

    // Serial render queue: load one web map at a time so heavy layers don't fight for the main thread.
    let renderQueue: Promise<unknown> = Promise.resolve()
    for (const a of added) {
      if (a.kind !== 'webmap' || !a.webmap || layerMapRef.current.has(a.id)) continue
      const rec: { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[]; prims: unknown[]; flew: boolean } = { layers: [], ds: [], prims: [], flew: false }
      layerMapRef.current.set(a.id, rec)
      renderQueue = renderQueue.then(() => renderOperationalLayers(v, a, rec))
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
    </div>
  )
}

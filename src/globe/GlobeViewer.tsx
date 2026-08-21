import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useAppStore } from '../state/store'
import { registerViewer, unregisterViewer } from './cameraApi'
import { renderableLayersFromWebmap } from './assess'
import {
  providerForWebLayer,
  isFeatureLayer,
  isGeoJsonLayer,
  fetchFeatureGeoJSON,
  fetchFeatureStyle,
  isKmlLayer,
  WORLD_IMAGERY_TILES,
  WORLD_LABELS_TILES,
  WORLD_IMAGERY_WGS84_TILES,
} from './webmap'

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

export function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const added = useAppStore((s) => s.added)
  const theme = useAppStore((s) => s.theme)
  const effects = useAppStore((s) => s.effects)
  const effectsRef = useRef(effects)
  effectsRef.current = effects
  const layerMapRef = useRef<Map<string, { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[] }>>(new Map())

  // 创建 viewer（仅一次）
  useEffect(() => {
    const el = containerRef.current
    if (!el || viewerRef.current) return
    const v = new Cesium.Viewer(el, {
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
    viewerRef.current = v
    registerViewer(v)
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
      const factor = e.deltaY > 0 ? 1.25 : 0.8
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
      if (effectsRef.current.autoRotate && performance.now() - lastInteract > 3000) {
        const fl = c as unknown as { _currentFlight?: unknown }
        if (!fl._currentFlight) {
          // 自动旋转：沿东西方向绕地球转（经度递增，保持纬度/高度/朝向不变）
          const carto = c.positionCartographic
          c.setView({
            destination: Cesium.Cartesian3.fromRadians(
              carto.longitude + 0.0012,
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
          c.moveForward(diff * 0.25)
        }
        if (Math.abs(diff) > h * 0.005) {
          settledFrames = 0
          v.scene.globe.maximumScreenSpaceError = 4
        } else {
          settledFrames++
          if (settledFrames > 8) {
            v.scene.globe.maximumScreenSpaceError = 2
          }
        }
      } else {
        targetH = h
        v.scene.globe.maximumScreenSpaceError = 2
      }
    }
    v.scene.postUpdate.addEventListener(onCameraFrame)
    v.scene.globe.tileCacheSize = 300
    v.scene.globe.preloadSiblings = true

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
      const targetH2 = Math.max(MIN_ZOOM * 2, curH * 0.5)
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
        layerMapRef.current.delete(id)
      }
    }

    // 渲染新增的 Web Map 操作图层（异步：需探测图层坐标系以匹配 tilingScheme）
    const renderOperationalLayers = async (
      v: Cesium.Viewer,
      a: (typeof added)[number],
      rec: { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[] },
    ) => {
      const wm = a.webmap as Record<string, unknown> | undefined
      if (!wm) return
      for (const op of renderableLayersFromWebmap(wm)) {
        if (op.visibility === false) continue
        const img = await providerForWebLayer(op)
        if (cancelled || v.isDestroyed()) return
        if (img) {
          const il = new Cesium.ImageryLayer(img)
          if (typeof op.opacity === 'number') il.alpha = op.opacity
          rec.layers.push(il)
          layers.add(il)
        } else if (op.url) {
          if (isFeatureLayer(op)) {
            // 并行拉取要素数据与符号样式（SimpleRenderer → Cesium 样式）
            Promise.all([fetchFeatureGeoJSON(op.url), fetchFeatureStyle(op.url)])
              .then(([gj, style]) => {
                if (cancelled || v.isDestroyed()) return undefined
                return Cesium.GeoJsonDataSource.load(gj as never, style
                  ? {
                      markerColor: style.markerColor,
                      markerSize: style.markerSize,
                      stroke: style.stroke,
                      strokeWidth: style.strokeWidth,
                      fill: style.fill,
                    }
                  : undefined)
              })
              .then((ds) => {
                if (cancelled || v.isDestroyed() || !ds) return
                if (!added.some((x) => x.id === a.id)) return
                v.dataSources.add(ds)
                rec.ds.push(ds)
              })
              .catch((e) => console.error('[layer] Feature 图层加载失败', op.url, e))
          } else if (isGeoJsonLayer(op)) {
            Cesium.GeoJsonDataSource.load(op.url)
              .then((ds) => {
                if (cancelled || v.isDestroyed()) return
                if (!added.some((x) => x.id === a.id)) return
                v.dataSources.add(ds)
                rec.ds.push(ds)
              })
              .catch((e) => console.error('[layer] GeoJSON 图层加载失败', op.url, e))
          } else if (isKmlLayer(op)) {
            Cesium.KmlDataSource.load(op.url)
              .then((ds) => {
                if (cancelled || v.isDestroyed()) return
                if (!added.some((x) => x.id === a.id)) return
                v.dataSources.add(ds)
                rec.ds.push(ds)
              })
              .catch((e) => console.error('[layer] KML 图层加载失败', op.url, e))
          }
        }
      }
    }

    for (const a of added) {
      if (a.kind !== 'webmap' || !a.webmap || layerMapRef.current.has(a.id)) continue
      const rec: { layers: Cesium.ImageryLayer[]; ds: Cesium.DataSource[] } = { layers: [], ds: [] }
      layerMapRef.current.set(a.id, rec)
      void renderOperationalLayers(v, a, rec)
    }

    return () => {
      cancelled = true
    }
  }, [added])


  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}

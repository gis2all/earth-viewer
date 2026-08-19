import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useAppStore } from '../state/store'
import { catalog } from '../layers/catalog'
import { baseLayerFor } from './providers'
import { registerViewer, unregisterViewer } from './cameraApi'

const TERRAIN_URL =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

// 相机限制
const MIN_ZOOM = 50000 // 最近 50km，防止穿地
const MAX_ZOOM = 25000000 // 最远 2.5 万 km，球不至于缩成小点
const MIN_PITCH = Cesium.Math.toRadians(-89.9) // 不能翻过正下方
const MAX_PITCH = Cesium.Math.toRadians(0) // 最多贴地平线，不翻到天空侧

export function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)

  const activeBase = useAppStore((s) => s.activeBase)
  const activeOverlays = useAppStore((s) => s.activeOverlays)

  // 创建 viewer（仅一次，相机永不重置）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
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
    ;(window as unknown as { __evViewer: Cesium.Viewer; __Cesium: typeof Cesium }).__evViewer = v
    ;(window as unknown as { __Cesium: typeof Cesium }).__Cesium = Cesium

    // 双击地球 → 向点击点 zoom in（保持当前朝向）
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      const picked = v.camera.pickEllipsoid(movement.position, v.scene.globe.ellipsoid)
      if (!picked) return
      const carto = v.scene.globe.ellipsoid.cartesianToCartographic(picked)
      const curH = v.camera.positionCartographic.height
      const targetH = Math.max(MIN_ZOOM * 2, curH * 0.5)
      v.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
          targetH
        ),
        orientation: { heading: v.camera.heading, pitch: v.camera.pitch, roll: 0 },
      })
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

    // 相机控制：左键旋转 / 右键倾斜 / 滚轮缩放（Google Earth 习惯）
    const scc = v.scene.screenSpaceCameraController
    scc.tiltEventTypes = Cesium.CameraEventType.RIGHT_DRAG
    scc.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH]
    scc.minimumZoomDistance = MIN_ZOOM
    scc.maximumZoomDistance = MAX_ZOOM

    // 倾斜角度钳制：pitch ∈ [MIN_PITCH, MAX_PITCH]
    const clampPitch = () => {
      const c = v.camera
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
    }
    v.scene.postUpdate.addEventListener(clampPitch)

    return () => {
      v.scene.postUpdate.removeEventListener(clampPitch)
      handler.destroy()
      unregisterViewer()
      v.destroy()
      viewerRef.current = null
    }
  }, [])

  // 基底影像切换：命令式替换图层，相机不动
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    const layers = v.imageryLayers
    while (layers.length > 0) layers.remove(layers.get(0))
    const def = catalog.find((l) => l.id === activeBase)
    layers.add(baseLayerFor(def))
  }, [activeBase])

  // 真实地形：地形底图 → ArcGIS 高程 + 光照阴影；其它 → 平面
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    const want = activeBase === 'terrain'
    let cancelled = false
    if (want) {
      Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_URL).then((p) => {
        if (cancelled || v.isDestroyed()) return
        v.terrainProvider = p
        v.scene.globe.enableLighting = true
      })
    } else {
      v.terrainProvider = new Cesium.EllipsoidTerrainProvider()
      v.scene.globe.enableLighting = false
    }
    return () => {
      cancelled = true
    }
  }, [activeBase])

  // 叠加图层：行政边界 3D 凸起
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    const want = activeOverlays.includes('boundary')
    let existing: Cesium.DataSource | undefined
    for (let i = 0; i < v.dataSources.length; i++) {
      const d = v.dataSources.get(i)
      if (d.name === 'countries') existing = d
    }
    if (want && !existing) {
      Cesium.GeoJsonDataSource.load('/data/countries.geojson').then((loaded) => {
        loaded.name = 'countries'
        for (const e of loaded.entities.values) {
          const p = e.polygon as unknown as {
            height: number
            extrudedHeight: number
            material: unknown
            outline: boolean
            outlineColor: unknown
          } | undefined
          if (p) {
            p.height = 0
            p.extrudedHeight = 60000
            p.material = Cesium.Color.fromCssColorString('rgba(110,121,214,0.5)')
            p.outline = true
            p.outlineColor = Cesium.Color.fromCssColorString('rgba(206,212,231,0.75)')
          }
        }
        if (v.isDestroyed()) return
        v.dataSources.add(loaded)
      })
    } else if (!want && existing) {
      v.dataSources.remove(existing, true)
    }
  }, [activeOverlays])

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}

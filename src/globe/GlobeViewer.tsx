import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useAppStore } from '../state/store'
import { catalog } from '../layers/catalog'
import { baseLayerFor } from './providers'

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
    ;(window as unknown as { __evViewer: Cesium.Viewer }).__evViewer = v
    return () => {
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

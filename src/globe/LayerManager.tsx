import { GeoJsonDataSource } from 'resium'
import * as Cesium from 'cesium'
import { useAppStore } from '../state/store'

/** 加载国界后：给每个国家多边形加高度 → 3D 凸起地块 */
function applyBoundary(ds: Cesium.GeoJsonDataSource) {
  const entities = ds.entities.values
  for (const e of entities) {
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
}

/** 根据当前叠加图层，渲染对应的数据源 */
export function LayerManager() {
  const activeOverlays = useAppStore((s) => s.activeOverlays)

  return (
    <>
      {activeOverlays.includes('boundary') && (
        <GeoJsonDataSource data="/data/countries.geojson" onLoad={applyBoundary} />
      )}
    </>
  )
}

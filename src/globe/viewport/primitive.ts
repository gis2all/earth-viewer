import * as Cesium from 'cesium'
import type { GeometryModel } from './geometryModel'
import { clusterPoints } from './cluster'

export interface LayerPrimitive {
  /** 加入 scene.primitives 的集合；dispose 时移除 */
  collection: Cesium.PrimitiveCollection
  dispose: () => void
}

/**
 * 用底层 Primitive（点集/线集/面几何）渲染预算后的几何模型，替代 GeoJsonDataSource+Entity 的内存开销。
 * 仅在真实 Cesium 环境调用（mock/无 Primitive API 时调用方应回退）。
 */
export function buildLayerPrimitive(scene: Cesium.Scene, model: GeometryModel): LayerPrimitive {
  const collection = new Cesium.PrimitiveCollection()

  // 点 → PointPrimitiveCollection（先网格聚类，防密集点内存爆炸）
  if (model.points.length) {
    const pc = new Cesium.PointPrimitiveCollection()
    const clustered = model.points.length > 2000 ? clusterPoints(model.points, 0.05).map((c) => [c.lon, c.lat]) : model.points
    for (const p of clustered as number[][]) {
      if (typeof p[0] !== 'number' || typeof p[1] !== 'number') continue
      pc.add({ position: Cesium.Cartesian3.fromDegrees(p[0], p[1]) })
    }
    collection.add(pc)
  }

  // 线 → PolylineCollection
  if (model.lines.length) {
    const lc = new Cesium.PolylineCollection()
    for (const line of model.lines) {
      const pts = Cesium.Cartesian3.fromDegreesArray(line.flat())
      if (pts.length >= 2) lc.add({ positions: pts })
    }
    collection.add(lc)
  }

  // 面 → Primitive(PolygonGeometry) + per-instance color
  if (model.polygons.length) {
    const instances: Cesium.GeometryInstance[] = []
    for (const poly of model.polygons) {
      const outer = poly[0]
      if (!Array.isArray(outer) || outer.length < 3) continue
      const positions = Cesium.Cartesian3.fromDegreesArray(outer.flat())
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(positions) }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString('#3f88c5')),
          },
        })
      )
    }
    if (instances.length) {
      collection.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({ flat: true }),
        })
      )
    }
  }

  return {
    collection,
    dispose: () => scene.primitives.remove(collection),
  }
}

/** 当前环境是否提供底层 Primitive API（真实 Cesium 才支持）。 */
export function hasPrimitiveRendering(): boolean {
  try {
    return typeof (Cesium as unknown as Record<string, unknown>).PointPrimitiveCollection === 'function'
  } catch {
    return false
  }
}

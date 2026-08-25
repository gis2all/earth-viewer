export interface GeometryModel {
  /** 点：每个 [lon, lat] */
  points: number[][]
  /** 线：每条线是坐标数组 */
  lines: number[][][]
  /** 面：每个面是环数组（[ring][coord]） */
  polygons: number[][][][]
}

/** 把预算后的 GeoJSON features 转成「点/线/面」坐标模型，供 Cesium Primitive 渲染。 */
export function featuresToGeometryModel(features: Record<string, unknown>[]): GeometryModel {
  const model: GeometryModel = { points: [], lines: [], polygons: [] }
  for (const f of features) {
    const g = f?.geometry as { type?: string; coordinates?: unknown } | undefined
    const type = g?.type
    const c = g?.coordinates
    if (!Array.isArray(c)) continue
    if (type === 'Point') model.points.push(c as number[])
    else if (type === 'MultiPoint') (c as number[][]).forEach((p) => model.points.push(p))
    else if (type === 'LineString') model.lines.push(c as number[][])
    else if (type === 'MultiLineString') (c as number[][][]).forEach((l) => model.lines.push(l))
    else if (type === 'Polygon') model.polygons.push(c as number[][][])
    else if (type === 'MultiPolygon') (c as number[][][][]).forEach((poly) => model.polygons.push(poly))
  }
  return model
}

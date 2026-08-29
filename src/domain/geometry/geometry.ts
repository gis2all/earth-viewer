/** 纯几何算法与模型：视口 envelope、点聚类、点/线/面模型转换、Douglas-Peucker 抽稀（零渲染依赖）。 */

/** 视口经纬度范围（度）。 */
export interface ViewEnvelope {
  west: number
  south: number
  east: number
  north: number
}

/** Cesium Rectangle 的 four corners（弧度）→ 经纬度（度）。视口驱动查询用。 */
export function rectangleToEnvelope(rect: { west: number; south: number; east: number; north: number } | undefined | null): ViewEnvelope | null {
  if (!rect) return null
  const rad = Math.PI / 180
  return {
    west: rect.west / rad,
    south: rect.south / rad,
    east: rect.east / rad,
    north: rect.north / rad,
  }
}

/** 从 Cesium camera（或其 mock）计算视口 envelope；无则回退全局。 */
export function viewEnvelopeFromCamera(
  camera: { computeViewRectangle?: () => { west: number; south: number; east: number; north: number } | undefined } | undefined | null
): ViewEnvelope | null {
  if (!camera?.computeViewRectangle) return null
  const rect = camera.computeViewRectangle()
  return rectangleToEnvelope(rect as { west: number; south: number; east: number; north: number } | undefined | null)
}

export interface ClusterPoint {
  lon: number
  lat: number
  count: number
}

/**
 * 网格聚类：把密集点按经纬度网格合并为簇中心点（减少 Primitive 数量、防点层内存爆炸）。
 * radiusDeg 为网格边长（度）。返回簇（含计数）。
 */
export function clusterPoints(points: number[][], radiusDeg: number): ClusterPoint[] {
  if (!(radiusDeg > 0)) return []
  const map = new Map<string, ClusterPoint>()
  const clusters: ClusterPoint[] = []
  for (const p of points) {
    if (typeof p[0] !== 'number' || typeof p[1] !== 'number') continue
    const key = `${Math.round(p[0] / radiusDeg)},${Math.round(p[1] / radiusDeg)}`
    let c = map.get(key)
    if (!c) {
      c = { lon: p[0], lat: p[1], count: 0 }
      map.set(key, c)
      clusters.push(c)
    }
    c.count++
    c.lon = (c.lon * (c.count - 1) + p[0]) / c.count
    c.lat = (c.lat * (c.count - 1) + p[1]) / c.count
  }
  return clusters
}

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

type Coord = [number, number]

function squaredDist(a: Coord, b: Coord): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

/** Douglas-Peucker 简化一条线（坐标数组），tolerance 为平方距离阈值。 */
export function simplifyLine(points: Coord[], tolerance: number): Coord[] {
  if (points.length <= 2) return points
  const tol2 = tolerance * tolerance
  let maxD = -1
  let idx = -1
  const first = points[0]
  const last = points[points.length - 1]
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegmentSq(points[i], first, last)
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (idx > 0 && maxD > tol2) {
    const left = simplifyLine(points.slice(0, idx + 1), tolerance)
    const right = simplifyLine(points.slice(idx), tolerance)
    return left.slice(0, -1).concat(right)
  }
  return [first, last]
}

function pointToSegmentSq(p: Coord, a: Coord, b: Coord): number {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const apx = p[0] - a[0]
  const apy = p[1] - a[1]
  const len2 = abx * abx + aby * aby
  let t = 0
  if (len2 !== 0) t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2))
  const cx = a[0] + t * abx
  const cy = a[1] + t * aby
  return squaredDist(p, [cx, cy])
}

/** 简化 FeatureCollection 中所有 LineString/Polygon/Multi 几何；Point 不变。 */
export function simplifyFeatureCollection<T extends { type: string; features: Record<string, unknown>[] }>(
  fc: T,
  tolerance: number
): T {
  const simplifyCoords = (coords: unknown[]): unknown[] => {
    if (!Array.isArray(coords) || coords.length === 0) return coords
    // Point：已是 [x,y]
    if (typeof coords[0] === 'number') return coords
    // LineString / PolygonRing：元素是 [x,y]（Coord[]）→ 整条按 DP 简化
    if (Array.isArray(coords[0]) && typeof (coords[0] as unknown[])[0] === 'number') {
      return simplifyLine(coords as unknown as Coord[], tolerance)
    }
    // Multi / Polygon：元素是坐标数组 → 递归
    return coords.map((c) => simplifyCoords(c as unknown[]))
  }
  const features = fc.features.map((f) => {
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined
    if (!g || !Array.isArray(g.coordinates)) return f
    return { ...f, geometry: { ...g, coordinates: simplifyCoords(g.coordinates) } }
  })
  return { ...fc, features } as T
}

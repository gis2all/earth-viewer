
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

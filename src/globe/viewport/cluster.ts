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

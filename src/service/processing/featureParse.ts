/** GeoJSON 纯解析/统计（无网络、无渲染依赖）——视口数据加工共用的底层工具。 */

/** 把 Geojson/ArcGIS 响应统一成 { type, features }。 */
export function parseFeatureCollection(json: unknown): { type: 'FeatureCollection'; features: Record<string, unknown>[] } {
  const j = json as { type?: string; features?: Record<string, unknown>[]; geometry?: unknown; properties?: unknown } | null
  if (!j || typeof j !== 'object') return { type: 'FeatureCollection', features: [] }
  if (Array.isArray(j.features)) return { type: 'FeatureCollection', features: j.features }
  // 单个 Feature（GeoJSON 文件可能直接给一个 Feature）
  if (j.type === 'Feature' || j.geometry || j.properties) return { type: 'FeatureCollection', features: [j as Record<string, unknown>] }
  return { type: 'FeatureCollection', features: [] }
}

/** 统计单个 feature 的几何顶点数（坐标对数）。 */
export function countVertices(feature: Record<string, unknown>): number {
  const g = feature?.geometry as { coordinates?: unknown } | undefined
  const c = g?.coordinates
  if (!Array.isArray(c)) return 0
  if (typeof c[0] === 'number') return 1
  let n = 0
  const walk = (arr: unknown[]): void => {
    for (const item of arr) {
      if (Array.isArray(item)) {
        if (typeof item[0] === 'number') n++
        else walk(item as unknown[])
      }
    }
  }
  walk(c)
  return n
}

/** 统计 FeatureCollection 的总顶点数（比"要素数"更能反映内存占用）。 */
export function countFeatureCollectionVertices(fc: { type: string; features: Record<string, unknown>[] } | unknown): number {
  const features = (fc as { features?: Record<string, unknown>[] } | null)?.features
  if (!Array.isArray(features)) return 0
  let n = 0
  for (const f of features) n += countVertices(f)
  return n
}

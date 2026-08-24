import { SAFETY } from '../loadSafety'

/** 视口经纬度范围（度）。 */
export interface ViewEnvelope {
  west: number
  south: number
  east: number
  north: number
}

export interface FeatureQueryOptions {
  /** 单次查询返回要素上限（防一屏拉爆） */
  maxFeatures?: number
  /** 返回字段；默认只取空间几何（内存最小） */
  outFields?: string
  /** 输出坐标系；默认 4326（Cesium 用） */
  outSR?: number
}

/** ArcGIS 服务的查询地址（FeatureServer/MapServer）：根不含层号时补 /0。 */
export function layerQueryBase(serviceUrl: string): string {
  const url = serviceUrl.replace(/\/+$/, '')
  if (/\/(FeatureServer|MapServer)$/i.test(url)) return url + '/0'
  return url
}

/** 构造"只取当前视口"的 FeatureServer/MapServer query URL（f=geojson）。 */
export function buildFeatureQueryUrl(
  serviceUrl: string,
  env: ViewEnvelope,
  opts: FeatureQueryOptions = {}
): string {
  const base = layerQueryBase(serviceUrl)
  const queryBase = base + '/query'
  const sep = queryBase.includes('?') ? '&' : '?'
  const geometry = `${env.west},${env.south},${env.east},${env.north}`
  const p = new URLSearchParams()
  p.set('where', '1=1')
  p.set('geometry', geometry)
  p.set('geometryType', 'esriGeometryEnvelope')
  p.set('spatialRel', 'esriSpatialRelIntersects')
  p.set('inSR', '4326')
  p.set('outSR', String(opts.outSR ?? 4326))
  // 视口渲染只需要几何做 Primitive；属性可选（默认 outFields=*，但预算会控制数量）
  p.set('outFields', opts.outFields ?? '*')
  p.set('returnGeometry', 'true')
  p.set('f', 'geojson')
  p.set('resultRecordCount', String(opts.maxFeatures ?? SAFETY.MAX_FEATURES))
  return queryBase + sep + p.toString()
}

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

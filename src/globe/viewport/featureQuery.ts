import { SAFETY } from '../loadSafety'
import { withFetchTimeout } from '../webmap'

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

/** 将服务根地址解析为可查询层：优先选择“分色渲染器”（uniqueValue/classBreaks）的事件层，避免只渲染静态区域层；无分色层时回退首层。 */
const queryBaseCache = new Map<string, string>()
const layerRendererCache = new Map<string, string>()

async function layerRendererType(layerUrl: string): Promise<string> {
  const cached = layerRendererCache.get(layerUrl)
  if (cached) return cached
  try {
    const r = await fetch(layerUrl + '?f=json', { signal: withFetchTimeout() })
    if (r.ok) {
      const j = (await r.json()) as { drawingInfo?: { renderer?: { type?: string } } } | null
      const t = j?.drawingInfo?.renderer?.type ?? ''
      layerRendererCache.set(layerUrl, t)
      return t
    }
  } catch { /* 层元数据探测失败忽略 */ }
  return ''
}

export async function resolveFeatureQueryBase(serviceUrl: string): Promise<string> {
  const url = serviceUrl.replace(/\/+$/, '')
  if (!/\/(FeatureServer|MapServer)$/i.test(url)) return url
  const cached = queryBaseCache.get(url)
  if (cached) return cached
  try {
    const r = await fetch(url + '?f=json', { signal: withFetchTimeout() })
    if (r.ok) {
      const j = (await r.json()) as { layers?: { id?: number }[] } | null
      const layers = j?.layers ?? []
      let chosen = layers.length && layers[0]?.id != null ? layers[0].id : 0
      for (const l of layers) {
        if (l?.id == null) continue
        const t = await layerRendererType(url + '/' + l.id)
        if (t === 'uniqueValue' || t === 'classBreaks') { chosen = l.id; break }
      }
      const base = url + '/' + chosen
      queryBaseCache.set(url, base)
      return base
    }
  } catch { /* 探测失败回退 /0 */ }
  return url + '/0'
}

/** 构造"只取当前视口"的 FeatureServer/MapServer query URL（f=geojson）。 */

/** 探测服务的全部可查询层与数据范围（fullExtent，保留 wkid 供重投影）。 */
export interface FeatureServiceInfo {
  layers: string[]
  extent?: { west: number; south: number; east: number; north: number; wkid: number }
}
const featureServiceCache = new Map<string, FeatureServiceInfo>()
export async function resolveFeatureService(serviceUrl: string): Promise<FeatureServiceInfo> {
  const url = serviceUrl.replace(/\/+$/, '')
  if (!/\/(FeatureServer|MapServer)$/i.test(url)) return { layers: [url] }
  const cached = featureServiceCache.get(url)
  if (cached) return cached
  try {
    const r = await fetch(url + '?f=json', { signal: withFetchTimeout() })
    if (r.ok) {
      const j = (await r.json()) as {
        layers?: { id?: number }[]
        fullExtent?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number }
        spatialReference?: { wkid?: number }
      } | null
      const layers = (j?.layers ?? []).map((l) => url + '/' + l.id)
      const info: FeatureServiceInfo = { layers }
      const fe = j?.fullExtent
      const wkid = j?.spatialReference?.wkid ?? 4326
      if (fe && [fe.xmin, fe.ymin, fe.xmax, fe.ymax].every((n) => typeof n === 'number')) {
        info.extent = { west: fe.xmin as number, south: fe.ymin as number, east: fe.xmax as number, north: fe.ymax as number, wkid }
      }
      featureServiceCache.set(url, info)
      return info
    }
  } catch { /* 探测失败忽略 */ }
  return { layers: [url + '/0'] }
}
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

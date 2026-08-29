import { SAFETY } from '../../domain/loadSafety'
import { fetchJson } from '../../service/http'
import type { ViewEnvelope } from '../../domain/geometry/geometry'
import {
  parseFeatureCollection,
  countVertices,
  countFeatureCollectionVertices,
} from '../../service/processing/viewportPipeline'

export { parseFeatureCollection, countVertices, countFeatureCollectionVertices }

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
    const r = await fetchJson<Response>(layerUrl + '?f=json', undefined, { throwHttpErrors: false })
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
    const r = await fetchJson<Response>(url + '?f=json', undefined, { throwHttpErrors: false })
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
    const r = await fetchJson<Response>(url + '?f=json', undefined, { throwHttpErrors: false })
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

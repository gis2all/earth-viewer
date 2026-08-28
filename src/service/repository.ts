/**
 * ArcGISRepository（W2.1）：全项目唯一的 ArcGIS 数据访问入口。
 * 收口内容：
 * - search：LayerPanel 的 buildSearchQuery / mergeSearchResults / fetchSearchPage / SEARCH_* 常量
 * - item 元数据：fetchItemMetadata / 预检缓存与 preflight
 * - item data / 容器：fetchWebmap
 * - 服务探测：detectMapService + CRS_CACHE
 * - 要素数据：fetchFeatureGeoJSON / fetchFeatureRenderer
 * 所有请求走 service/http.ts 中间件（超时 / 429 退避 / abort / 错误归一化）。
 * UI 层（LayerPanel）与渲染层（GlobeViewer）不得再直接 fetch ArcGIS。
 */
import { SEARCH_ITEM_TYPES, isWebMapContainer } from '../globe/itemTypes'
import { DEFAULT_BUDGET_POLICY } from '../domain/policy'
import { fetchJson, HttpError } from './http'

// ---------- 搜索结果 ----------

export interface SearchResult {
  id: string
  title: string
  thumbnail?: string
  snippet?: string
  numViews?: number
  fidelity?: 'full' | 'partial' | 'none'
  url?: string
  type?: string
  contentStatus?: string
  groupDesignations?: string | string[]
  typeKeywords?: string[]
  tags?: string[]
}

export type ItemMetadata = Pick<SearchResult, 'contentStatus' | 'groupDesignations'>

export type SearchType = (typeof SEARCH_ITEM_TYPES)[number]

export const SEARCH_TYPES: SearchType[] = [...SEARCH_ITEM_TYPES]
/** 单类型单页大小（ArcGIS search num 参数）。 */
export const SEARCH_PAGE = 12

/** 权威过滤：只显示权威数据，排除 deprecated。 */
export const AUTHORITATIVE_FILTER =
  'AND (contentstatus:"org_authoritative" OR contentstatus:"public_authoritative") NOT contentstatus:"deprecated"'

export function buildSearchQuery(type: SearchType, keyword: string): string {
  const query = `type:"${type}" AND access:public ${AUTHORITATIVE_FILTER}`
  return keyword ? query + ' AND (' + keyword + ')' : query
}

/** 多类型分页结果合并：按 id 去重，按 numViews 降序（相同则按 id 稳定排序）。 */
export function mergeSearchResults(groups: SearchResult[][]): SearchResult[] {
  const seen = new Set<string>()
  return groups
    .flat()
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .sort((a, b) => {
      const views = (b.numViews ?? 0) - (a.numViews ?? 0)
      return views || a.id.localeCompare(b.id)
    })
}

/** 拉取单类型单页搜索结果；HTTP 失败抛 Error('ArcGIS 搜索失败')（与旧行为一致）。 */
export async function fetchSearchPage(
  type: SearchType,
  keyword: string,
  start: number,
  signal?: AbortSignal
): Promise<{ results: SearchResult[]; nextStart?: number | null }> {
  const q = buildSearchQuery(type, keyword)
  const url =
    '/sharing/rest/search?q=' +
    encodeURIComponent(q) +
    '&f=json&num=' +
    SEARCH_PAGE +
    '&start=' +
    start +
    '&sortField=numViews&sortOrder=desc'
  try {
    const j = await fetchJson<{ results?: SearchResult[]; nextStart?: number }>(url, { signal })
    return {
      results: (j.results ?? []).map((it) => ({
        id: it.id,
        title: it.title,
        thumbnail: it.thumbnail,
        snippet: it.snippet,
        numViews: it.numViews,
        url: it.url,
        type: it.type,
        contentStatus: it.contentStatus,
        groupDesignations: it.groupDesignations,
        typeKeywords: it.typeKeywords,
        tags: it.tags,
      })),
      nextStart: j.nextStart,
    }
  } catch (e) {
    if (e instanceof HttpError) throw new Error('ArcGIS 搜索失败', { cause: e })
    throw e
  }
}

// ---------- item 元数据 ----------

/** 补充搜索结果缺失的权威 / Living Atlas 状态（contentStatus / groupDesignations）。 */
export async function fetchItemMetadata(id: string, signal?: AbortSignal): Promise<ItemMetadata | null> {
  try {
    const value = await fetchJson<Record<string, unknown> | null>(
      `/sharing/rest/content/items/${encodeURIComponent(id)}?f=json`,
      { signal }
    )
    if (!value || value.error) return null
    const contentStatus = typeof value.contentStatus === 'string' ? value.contentStatus : undefined
    const groupDesignations = Array.isArray(value.groupDesignations)
      ? value.groupDesignations.filter((v): v is string => typeof v === 'string')
      : typeof value.groupDesignations === 'string'
        ? value.groupDesignations
        : undefined
    return { contentStatus, groupDesignations }
  } catch {
    return null
  }
}

// ---------- 预检（服务可用性 / 24h 缓存） ----------

/** 服务类 item 才需要服务根预检；容器（Web Map/Scene）与文件类走点开后校验。 */
export const PREFLIGHT_TYPES = new Set<string>([
  'Map Service',
  'Feature Service',
  'Image Service',
  'Scene Service',
  'Vector Tile Service',
  'WMS',
  'WMTS',
  'WFS',
  'KML',
])

export const PREFLIGHT_ABORT_MS = 3000
const PREFLIGHT_CACHE_KEY = 'earth-viewer:preflight'
const PREFLIGHT_TTL_MS = 24 * 60 * 60 * 1000

export type PreflightState = 'ok' | 'bad'

export interface PreflightEntry {
  s: PreflightState
  t: number
}

export function readPreflightCache(): Map<string, PreflightEntry> {
  try {
    const raw = localStorage.getItem(PREFLIGHT_CACHE_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, PreflightEntry>
    const now = Date.now()
    const map = new Map<string, PreflightEntry>()
    for (const [k, v] of Object.entries(obj)) {
      if (v && (v.s === 'ok' || v.s === 'bad') && now - v.t < PREFLIGHT_TTL_MS) map.set(k, v)
    }
    return map
  } catch {
    return new Map()
  }
}

export function writePreflightCache(map: Map<string, PreflightEntry>): void {
  try {
    localStorage.setItem(PREFLIGHT_CACHE_KEY, JSON.stringify(Object.fromEntries(map.entries())))
  } catch {
    /* 忽略配额/隐私限制 */
  }
}

/** 轻量探测服务根：Token Required / Subscription canceled / 403 等 => 不可用。 */
export async function preflightService(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const sep = url.includes('?') ? '&' : '?'
    const j = await fetchJson<unknown>(url + sep + 'f=json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal,
    }, { timeoutMs: PREFLIGHT_ABORT_MS })
    const err = (j as { error?: unknown } | null)?.error
    return !!j && !err
  } catch {
    return false
  }
}

/** 按 item 类型选择预检方式：容器（Web Map/Scene）走 data（/sharing 代理），服务类走服务根。 */
export async function preflightItem(
  it: Pick<SearchResult, 'id' | 'type' | 'url'>,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    if (isWebMapContainer(it.type ?? '')) {
      const j = await fetchJson<unknown>(`/sharing/rest/content/items/${it.id}/data?f=json`, { signal }, { timeoutMs: PREFLIGHT_ABORT_MS })
      return !!j && !(j as { error?: unknown } | null)?.error
    }
    if (it.url) return await preflightService(it.url, signal)
    return true
  } catch {
    return false
  }
}

// ---------- item data / 容器 ----------

/** 拉取 Web Map JSON（/sharing 代理，支持 AbortSignal 取消）；HTTP 失败抛 Error('获取 Web Map 失败')。 */
export async function fetchWebmap(itemId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    return await fetchJson<Record<string, unknown>>(`/sharing/rest/content/items/${itemId}/data?f=json`, { signal })
  } catch (e) {
    if (e instanceof HttpError) throw new Error('获取 Web Map 失败', { cause: e })
    throw e
  }
}

// ---------- 服务探测（CRS / 最大级别 / 是否缓存瓦片） ----------

export interface MapServiceInfo {
  wkid: number
  maxLevel: number
  /** 是否有缓存瓦片（tileInfo）——false 表示动态 MapServer，不能用 /tile/ 模板请求 */
  tiled: boolean
}

/** 服务坐标系探测缓存（同一 URL 只探测一次）。 */
const CRS_CACHE = new Map<string, MapServiceInfo>()

/** 探测 MapServer/ImageServer：坐标系（wkid）、最大级别、是否缓存瓦片；失败返回 null。 */
export async function detectMapService(url: string): Promise<MapServiceInfo | null> {
  const base = url.replace(/\/?$/, '')
  const cached = CRS_CACHE.get(base)
  if (cached) return cached
  try {
    const j = await fetchJson<{
      spatialReference?: { wkid?: number; latestWkid?: number }
      tileInfo?: { lods?: unknown[] }
    }>(`${base}?f=json`)
    const wkid = j.spatialReference?.wkid ?? j.spatialReference?.latestWkid
    if (typeof wkid !== 'number') return null
    const lods = j.tileInfo?.lods
    const maxLevel = Array.isArray(lods) && lods.length ? lods.length - 1 : 0
    const info: MapServiceInfo = { wkid, maxLevel, tiled: !!j.tileInfo }
    CRS_CACHE.set(base, info)
    return info
  } catch {
    return null
  }
}

/** 测试辅助：清空 CRS 探测缓存。 */
export function clearCrsCache(): void {
  CRS_CACHE.clear()
}

// ---------- 要素数据 ----------

/** ArcGIS JSON (f=json) query -> GeoJSON FeatureCollection (Point/Line/Polygon)。 */
function arcgisQueryToFeatureCollection(j: { features?: Array<{ attributes?: Record<string, unknown>; geometry?: unknown }> }): { type: 'FeatureCollection'; features: unknown[] } {
  const features: unknown[] = []
  for (const f of j.features ?? []) {
    const g = f.geometry as { x?: number; y?: number; paths?: unknown[]; rings?: unknown[] } | null
    let geometry: unknown = null
    if (g && typeof g.x === 'number' && typeof g.y === 'number') {
      geometry = { type: 'Point', coordinates: [g.x, g.y] }
    } else if (g && Array.isArray(g.paths)) {
      geometry = { type: g.paths.length === 1 ? 'LineString' : 'MultiLineString', coordinates: g.paths.length === 1 ? (g.paths[0] as unknown[]) : g.paths }
    } else if (g && Array.isArray(g.rings)) {
      geometry = { type: 'Polygon', coordinates: g.rings }
    }
    features.push({ type: 'Feature', properties: f.attributes ?? {}, geometry })
  }
  return { type: 'FeatureCollection', features }
}

/** FeatureServer -> GeoJSON (paged, capped so huge services don't drag the page)。 */
export async function fetchFeatureGeoJSON(
  url: string,
  limit: number = DEFAULT_BUDGET_POLICY.maxFeatures,
  signal?: AbortSignal
): Promise<unknown> {
  const base = url.replace(/\/+$/, '')
  let pageSize = 2000
  let layerId = 0
  try {
    const m = await fetchJson<{ maxRecordCount?: number; layers?: Array<{ id?: number }> }>(`${base}?f=json`)
    if (typeof m.maxRecordCount === 'number' && m.maxRecordCount > 0 && m.maxRecordCount <= 4000) pageSize = m.maxRecordCount
    const firstLayer = m.layers?.find((l) => typeof l.id === 'number')
    if (firstLayer) layerId = firstLayer.id as number
  } catch {
    // default
  }
  const features: unknown[] = []
  let offset = 0
  let guard = 0
  let lastKey: string | null = null
  while (offset < limit && guard < 50) {
    guard++
    const geojsonUrl = `${base}/${layerId}/query?where=1%3D1&f=geojson&outFields=1&outSR=4326&resultOffset=${offset}&resultRecordCount=${pageSize}`
    let feats: unknown[]
    try {
      const gj = await fetchJson<{ features?: unknown[] }>(geojsonUrl, { signal })
      feats = gj.features ?? []
    } catch (e) {
      // 仅 HTTP 失败回退到 f=json 查询；网络错误 / 取消原样抛出（与旧行为一致）。
      if (!(e instanceof HttpError)) throw e
      const jsonUrl = `${base}/${layerId}/query?where=1%3D1&f=json&outFields=*&outSR=4326&resultOffset=${offset}&resultRecordCount=${pageSize}`
      try {
        const jj = await fetchJson<{ features?: Array<{ attributes?: Record<string, unknown>; geometry?: unknown }>; error?: { message?: string } }>(jsonUrl, { signal })
        if (jj.error) throw new Error('要素服务查询失败：' + (jj.error.message ?? ''), { cause: e })
        feats = arcgisQueryToFeatureCollection(jj).features
      } catch (err) {
        if (err instanceof HttpError) throw new Error('要素服务查询失败', { cause: err })
        throw err
      }
    }
    if (feats.length === 0) break
    if (feats.length < pageSize) {
      features.push(...feats)
      break
    }
    const key = JSON.stringify(feats[0])
    if (key === lastKey) break
    lastKey = key
    features.push(...feats)
    offset += feats.length
    if (offset >= limit) break
  }
  return { type: 'FeatureCollection', features }
}

/** 拉取 FeatureServer 的 drawingInfo.renderer（用于无样式兜底）；失败返回 null。 */
export async function fetchFeatureRenderer(url: string): Promise<Record<string, unknown> | null> {
  const base = url.replace(/\/?$/, '')
  try {
    const j = await fetchJson<{ drawingInfo?: { renderer?: Record<string, unknown> } }>(`${base}?f=json`)
    const renderer = j.drawingInfo?.renderer
    return renderer && typeof renderer === 'object' ? renderer : null
  } catch {
    return null
  }
}

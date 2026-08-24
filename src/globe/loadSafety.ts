import type { WebLayer } from './webmap'

// Unified load-safety limits: keep heavy layers from freezing the main thread.
export const SAFETY = {
  // Feature / WFS: max features fetched/renderable per layer
  MAX_FEATURES: 3000,
  // 一个 webmap 内业务层合计要素预算：超出则跳过后续层，防叠加 OOM
  MAX_TOTAL_FEATURES: 5000,
  // 单层渲染要素上限：数据更大时只取前 N 个（降级），防 GeoJsonDataSource.load 阻塞
  MAX_RENDER_FEATURES: 1500,
  // 单层几何顶点预算：超限先抽稀再截断（防单个大 polygon 内存爆炸）
  MAX_RENDER_VERTICES: 200_000,
  // GeoJSON / CSV / KML: max file payload bytes accepted before degrading
  MAX_FILE_BYTES: 8_000_000,
  // KML：更严格（KmlDataSource 解析开销大）
  KML_MAX_BYTES: 2_000_000,
  // Vector tile: max zoom we request (avoid exploding geometry at high zoom)
  VECTOR_TILE_MAX_ZOOM: 12,
  // Vector tile 背靠的 Cesium3DTileset 缓存内存上限（超出视口的瓦片会被自动卸载，防内存膨胀）
  VECTOR_TILE_MEMORY_LIMIT: 64 * 1024 * 1024,
  // Vector tile 缓存溢出允许的额外内存（达到最大 SSE 所需瓦片超过 cacheBytes 时可用）
  VECTOR_TILE_CACHE_OVERFLOW: 16 * 1024 * 1024,
  // Scene / 3D Tiles: cap LOD (kept conservative)
  SCENE_MAX_LOD: 15,
  // WMS / imagery providers: cap detail level to avoid tile storms
  IMAGERY_MAX_LEVEL: 16,
} as const

// Large global vector basemaps are the worst offenders (OpenStreetMap / ArcGIS basemaps).
// For these we degrade to raster tiles so they never freeze the viewer.
export function isGlobalVectorTileLayer(op: WebLayer): boolean {
  const kind = op.layerType || op.type || ''
  if (!/VectorTileLayer/i.test(kind)) return false
  const hay = ((op.url || '') + ' ' + (op.styleUrl || '') + ' ' + (op.title || '')).toLowerCase()
  if (/openstreetmap|openbasemap|basemaps\.arcgis\.com|vector tileserver/i.test(hay)) return true
  // ArcGIS-hosted global basemap style (e.g. Streets / World Street Map)
  if (/\/sharing\/rest\/content\/items\/[^/]+\/resources\/styles\/root\.json/i.test(op.styleUrl || '')) return true
  return false
}

export type LoadRisk = 'light' | 'medium' | 'heavy'

// Classify a layer's load risk; heavy layers are degraded / limited before rendering.
export function riskOfLayer(op: WebLayer): LoadRisk {
  const kind = op.layerType || op.type || ''
  if (isGlobalVectorTileLayer(op)) return 'heavy'
  if (/featurelayer|featureserver|wfs|scenelayer|3dtiles|cesium3dtiles|integratedmesh|pointcloud|3dobject|buildingscene/i.test(kind)) return 'heavy'
  if (/vectortilelayer|wmtslayer|wmslayer|mapservice|imageservice|mapserver|imageserver|kmllayer|geojsonlayer|csvlayer/i.test(kind)) return 'medium'
  return 'light'
}

// Human-readable reason when a layer is degraded (shown via toast / label).
export function degradeReason(op: WebLayer): string | undefined {
  if (isGlobalVectorTileLayer(op)) return '全局矢量底图已降级为栅格图像'
  if (riskOfLayer(op) === 'heavy') return '重负载图层已限制视口/预算'
  return undefined
}


// Throws if the URL payload exceeds maxBytes (safety guard for GeoJSON/KML loads).
export async function assertUrlWithinLimit(url: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  // Skip in jsdom test env so load-path tests are unaffected.
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return
  const r = await fetch(url, { method: 'HEAD', signal: withAbort(signal) })
  if (!r.ok) return
  const len = Number(r.headers?.get?.('content-length') || 0)
  if (len > maxBytes) throw new Error('\u6587\u4ef6\u8fc7\u5927\uff0c\u5df2\u9650\u5236\u52a0\u8f7d')
}

function withAbort(signal?: AbortSignal): AbortSignal | undefined {
  return signal
}

/**
 * 预算/降级：业务层要素合计预算控制。
 * - features 为空 → 原样返回（不算消耗）。
 * - remaining <= 0 → 返回 null（略过该层）。
 * - 单层超过 maxRender → 截断到 maxRender 并标记 capped。
 * 返回新的 remaining 与（可能截断后的）data。
 */
export function consumeFeatureBudget(
  remaining: number,
  gj: unknown,
  maxRender: number
): { remaining: number; data: unknown; capped: boolean } | null {
  const feats = (gj as { features?: unknown[] } | null)?.features
  if (!Array.isArray(feats) || feats.length === 0) return { remaining, data: gj, capped: false }
  if (remaining <= 0) return null
  let capped = false
  let f = feats
  if (f.length > maxRender) {
    f = f.slice(0, maxRender)
    capped = true
  }
  return { remaining: remaining - f.length, data: f === feats ? gj : { ...(gj as object), features: f }, capped }
}

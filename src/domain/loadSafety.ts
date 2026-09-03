import type { WebLayer } from './types'
import type { RiskLevel } from './types'
import { DEFAULT_APP_CONFIG } from './config'
import { classifyWebLayerKind } from './webLayerKind'

// Unified load-safety limits: keep heavy layers from freezing the main thread.
// W4.2：值统一来自 domain/config.ts（唯一来源）；保留大写下划线导出以兼容既有消费方。
export const SAFETY = {
  // Feature / WFS: max features fetched/renderable per layer
  MAX_FEATURES: DEFAULT_APP_CONFIG.maxFeatures,
  // 一个 webmap 内业务层合计要素预算：超出则跳过后续层，防叠加 OOM
  MAX_TOTAL_FEATURES: DEFAULT_APP_CONFIG.maxTotalFeatures,
  // 单层渲染要素上限：数据更大时只取前 N 个（降级），防 GeoJsonDataSource.load 阻塞
  MAX_RENDER_FEATURES: DEFAULT_APP_CONFIG.maxRenderFeatures,
  // 单层几何顶点预算：超限先抽稀再截断（防单个大 polygon 内存爆炸）
  MAX_RENDER_VERTICES: DEFAULT_APP_CONFIG.maxRenderVertices,
  // GeoJSON / CSV / KML: max file payload bytes accepted before degrading
  MAX_FILE_BYTES: DEFAULT_APP_CONFIG.maxFileBytes,
  // KML：更严格（KmlDataSource 解析开销大）
  KML_MAX_BYTES: DEFAULT_APP_CONFIG.kmlMaxBytes,
  // Vector tile (MapLibre 栅格化): 最大请求级别（MapLibre 逐瓦片 GPU 渲染，预算放宽到 16）
  VECTOR_TILE_MAX_ZOOM: DEFAULT_APP_CONFIG.vectorTileMaxZoom,
  // WMS / imagery providers: cap detail level to avoid tile storms
  IMAGERY_MAX_LEVEL: DEFAULT_APP_CONFIG.imageryMaxLevel,
} as const

/** 与 domain RiskLevel 对齐（M1 W1.1）；后续统一使用 domain 类型。 */
export type LoadRisk = RiskLevel

// Classify a layer's load risk; heavy layers are degraded / limited before rendering.
export function riskOfLayer(op: WebLayer): LoadRisk {
  switch (classifyWebLayerKind(op)) {
    case 'feature':
    case 'wfs':
    case 'scene':
    case '3dTiles':
      return 'heavy'
    case 'map':
    case 'image':
    case 'vectorTile':
    case 'featureCollection':
    case 'wms':
    case 'wmts':
    case 'kml':
    case 'geojson':
    case 'csv':
      return 'medium'
    default:
      return 'light'
  }
}

// Human-readable reason when a layer is degraded (shown via toast / label).
export function degradeReason(op: WebLayer): string | undefined {
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

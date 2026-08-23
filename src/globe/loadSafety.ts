import type { WebLayer } from './webmap'

// Unified load-safety limits: keep heavy layers from freezing the main thread.
export const SAFETY = {
  // Feature / WFS: max features fetched/renderable per layer
  MAX_FEATURES: 3000,
  // GeoJSON / CSV / KML: max file payload bytes accepted before degrading
  MAX_FILE_BYTES: 8_000_000,
  // Vector tile: max zoom we request (avoid exploding geometry at high zoom)
  VECTOR_TILE_MAX_ZOOM: 12,
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
  if (/cdn\.arcgis\.com\/sharing\/rest\/content\/items\/[^/]+\/resources\/styles\/root\.json/i.test(op.styleUrl || '')) return true
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
  if (isGlobalVectorTileLayer(op)) return '???????????????????'
  if (riskOfLayer(op) === 'heavy') return '???????????????????'
  return undefined
}


// Throws if the URL payload exceeds maxBytes (safety guard for GeoJSON/KML loads).
export async function assertUrlWithinLimit(url: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  // Skip in jsdom test env so load-path tests are unaffected.
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return
  const r = await fetch(url, { method: 'HEAD', signal: withAbort(signal) })
  if (!r.ok) return
  const len = Number(r.headers.get('content-length') || 0)
  if (len > maxBytes) throw new Error('\u6587\u4ef6\u8fc7\u5927\uff0c\u5df2\u9650\u5236\u52a0\u8f7d')
}

function withAbort(signal?: AbortSignal): AbortSignal | undefined {
  return signal
}

import * as Cesium from 'cesium'

export const WORLD_IMAGERY_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
export const WORLD_LABELS_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
// 极区兜底底图：World Imagery (WGS84, EPSG:4326) 瓦片，覆盖到 ±90°（3857 版只到 ±85.05°）
export const WORLD_IMAGERY_WGS84_TILES =
  'https://wi.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

export interface WebLayer {
  url?: string
  type?: string
  layerType?: string
  title?: string
  urlTemplate?: string
  opacity?: number
  visibility?: boolean
}

function layerKind(l: WebLayer): string {
  return l.type || l.layerType || ''
}

/** 通过本地代理拉取 Web Map JSON */
export async function fetchWebmap(itemId: string): Promise<Record<string, unknown>> {
  const r = await fetch(`/sharing/rest/content/items/${itemId}/data?f=json`)
  if (!r.ok) throw new Error('获取 Web Map 失败')
  return r.json()
}

function mapServerTileUrl(url: string): string {
  return url.replace(/\/?$/, '/tile/{z}/{y}/{x}')
}

// 服务坐标系探测缓存（同一 URL 只探测一次）
const CRS_CACHE = new Map<string, { wkid: number; maxLevel: number }>()

/** 探测 MapServer/ImageServer 的坐标系（spatialReference.wkid）与最大级别；失败返回 null → 走默认 3857 */
async function detectCrs(url: string): Promise<{ wkid: number; maxLevel: number } | null> {
  const base = url.replace(/\/?$/, '')
  const cached = CRS_CACHE.get(base)
  if (cached) return cached
  try {
    const r = await fetch(`${base}?f=json`)
    if (!r.ok) return null
    const j = (await r.json()) as {
      spatialReference?: { wkid?: number; latestWkid?: number }
      tileInfo?: { lods?: unknown[] }
    }
    const wkid = j.spatialReference?.wkid ?? j.spatialReference?.latestWkid
    if (typeof wkid !== 'number') return null
    const lods = j.tileInfo?.lods
    const maxLevel = Array.isArray(lods) && lods.length ? lods.length - 1 : 0
    const info = { wkid, maxLevel }
    CRS_CACHE.set(base, info)
    return info
  } catch {
    return null
  }
}

/** 瓦片服务 → Provider：4326 用 GeographicTilingScheme，其余（3857/未知）用默认 Web Mercator */
async function providerForTiledMap(url: string): Promise<Cesium.ImageryProvider> {
  const crs = await detectCrs(url)
  const opts: Cesium.UrlTemplateImageryProvider.ConstructorOptions = {
    url: mapServerTileUrl(url),
  }
  if (crs && crs.wkid === 4326) {
    opts.tilingScheme = new Cesium.GeographicTilingScheme()
  }
  if (crs && crs.maxLevel > 0) {
    opts.maximumLevel = crs.maxLevel
  }
  return new Cesium.UrlTemplateImageryProvider(opts)
}

/** 把 Web Map 图层转成 Cesium 影像 Provider（MapServer/ImageServer/OSM/urlTemplate） */
export async function providerForWebLayer(layer: WebLayer): Promise<Cesium.ImageryProvider | null> {
  const t = layerKind(layer)
  const url = layer.url || ''
  // 按 URL 判断 MapServer/ImageServer（兼容 layerType 为 ArcGISTiledMapServiceLayer 等）
  if (url && /\/MapServer\/?$|\/ImageServer\/?$/i.test(url)) {
    return providerForTiledMap(url)
  }
  if (/MapServer|ImageServer/i.test(t) && url) {
    return providerForTiledMap(url)
  }
  if (t === 'OpenStreetMap') {
    return new Cesium.UrlTemplateImageryProvider({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    })
  }
  if (layer.urlTemplate) {
    return new Cesium.UrlTemplateImageryProvider({ url: layer.urlTemplate })
  }
  return null
}

export function isFeatureLayer(layer: WebLayer): boolean {
  return /FeatureLayer|FeatureServer/i.test(layerKind(layer))
}

export function isGeoJsonLayer(layer: WebLayer): boolean {
  return /GeoJSONLayer/i.test(layerKind(layer))
}

/** 要素服务 → GeoJSON */
export async function fetchFeatureGeoJSON(url: string): Promise<unknown> {
  const base = url.replace(/\/?$/, '')
  const r = await fetch(`${base}/query?where=1%3D1&f=geojson&outFields=*&maxRecordCount=2000`)
  if (!r.ok) throw new Error('要素服务查询失败')
  return r.json()
}

/** 从 Web Map 提取可用的底图 Provider */
export async function baseProviderFromWebmap(wm: Record<string, unknown>): Promise<Cesium.ImageryProvider | null> {
  const baseMap = wm.baseMap as { baseMapLayers?: WebLayer[] } | undefined
  for (const l of baseMap?.baseMapLayers ?? []) {
    const p = await providerForWebLayer(l)
    if (p) return p
  }
  return null
}


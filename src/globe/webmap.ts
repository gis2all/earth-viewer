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
  /** WMS 图层的子图层列表（[{ name, title }]），WMS 图层名可能在此而非 layerName */
  layers?: unknown
  /** WMS 图层名（部分 webmap 直接给 layerName） */
  layerName?: string
}

function layerKind(l: WebLayer): string {
  return l.type || l.layerType || ''
}

/** 通过本地代理拉取 Web Map JSON（支持 AbortSignal 取消） */
export async function fetchWebmap(itemId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const r = await fetch(`/sharing/rest/content/items/${itemId}/data?f=json`, { signal })
  if (!r.ok) throw new Error('获取 Web Map 失败')
  return r.json()
}

function mapServerTileUrl(url: string): string {
  return url.replace(/\/?$/, '/tile/{z}/{y}/{x}')
}

// 服务坐标系探测缓存（同一 URL 只探测一次）
export interface MapServiceInfo {
  wkid: number
  maxLevel: number
  /** 是否有缓存瓦片（tileInfo）——false 表示动态 MapServer，不能用 /tile/ 模板请求 */
  tiled: boolean
}

const CRS_CACHE = new Map<string, MapServiceInfo>()

/** 探测 MapServer/ImageServer：坐标系（wkid）、最大级别、是否缓存瓦片；失败返回 null */
export async function detectMapService(url: string): Promise<MapServiceInfo | null> {
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
    const info: MapServiceInfo = { wkid, maxLevel, tiled: !!j.tileInfo }
    CRS_CACHE.set(base, info)
    return info
  } catch {
    return null
  }
}

const detectCrs = detectMapService

/** 瓦片服务 → Provider：4326 用 GeographicTilingScheme，其余（3857/未知）用默认 Web Mercator；动态服务（无 tileInfo）返回 null */
async function providerForTiledMap(url: string): Promise<Cesium.ImageryProvider | null> {
  const crs = await detectCrs(url)
  // 动态 MapServer：没有缓存瓦片，/tile/{z}/{y}/{x} 无效，不构造 provider
  if (crs && !crs.tiled) return null
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
  // WMS：用 WebMapServiceImageryProvider，需图层名（webmap 里可能是 layerName 或 layers 数组）
  if (/WMSLayer|WMS/i.test(t) && url) {
    let name = layer.layerName
    if (!name && Array.isArray(layer.layers) && layer.layers.length > 0) {
      name = (layer.layers[0] as { name?: string }).name
    }
    if (!name && typeof layer.layers === 'string') name = layer.layers
    if (!name) return null
    return new Cesium.WebMapServiceImageryProvider({ url, layers: name })
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

export function isKmlLayer(layer: WebLayer): boolean {
  return /KMLLayer|KML/i.test(layerKind(layer))
}

/** 要素服务 → GeoJSON（按 resultOffset 分页拉取，上限 limit 防止超大服务拖垮页面） */
export async function fetchFeatureGeoJSON(url: string, limit = 5000): Promise<unknown> {
  const base = url.replace(/\/?$/, '')
  // 探测服务单页上限（maxRecordCount）
  let pageSize = 2000
  try {
    const meta = await fetch(`${base}?f=json`)
    if (meta.ok) {
      const m = (await meta.json()) as { maxRecordCount?: number }
      if (typeof m.maxRecordCount === 'number' && m.maxRecordCount > 0 && m.maxRecordCount <= 4000) {
        pageSize = m.maxRecordCount
      }
    }
  } catch {
    // 探测失败则用默认页大小
  }
  const features: unknown[] = []
  let offset = 0
  let guard = 0
  let lastKey: string | null = null
  while (offset < limit && guard < 50) {
    guard++
    const r = await fetch(
      `${base}/query?where=1%3D1&f=geojson&outFields=*&resultOffset=${offset}&resultRecordCount=${pageSize}`
    )
    if (!r.ok) throw new Error('要素服务查询失败')
    const gj = (await r.json()) as { features?: unknown[] }
    const feats = gj.features ?? []
    if (feats.length === 0) break
    // 拉完（不足一页）则停止
    if (feats.length < pageSize) {
      features.push(...feats)
      break
    }
    // 重复页面检测：服务忽略 resultOffset 时每页返回相同数据，避免无限拉取
    const key = JSON.stringify(feats[0])
    if (key === lastKey) break
    lastKey = key
    features.push(...feats)
    offset += feats.length
    if (offset >= limit) break
  }
  return { type: 'FeatureCollection', features }
}

export interface FeatureStyle {
  markerColor?: Cesium.Color
  markerSize?: number
  stroke?: Cesium.Color
  strokeWidth?: number
  fill?: Cesium.Color
}

/** 从要素服务 metadata 读取 SimpleRenderer 符号，映射为 Cesium GeoJSON 样式（其余渲染器返回 null） */
export async function fetchFeatureStyle(url: string): Promise<FeatureStyle | null> {
  const base = url.replace(/\/?$/, '')
  try {
    const r = await fetch(`${base}?f=json`)
    if (!r.ok) return null
    const j = (await r.json()) as {
      drawingInfo?: { renderer?: { type?: string; symbol?: Record<string, unknown> } }
    }
    const renderer = j.drawingInfo?.renderer
    if (!renderer || renderer.type !== 'simple') return null
    const sym = renderer.symbol as {
      type?: string
      color?: number[]
      size?: number
      width?: number
      outline?: { color?: number[]; width?: number }
    }
    if (!sym) return null
    const toColor = (c?: number[]): Cesium.Color | undefined =>
      c && c.length >= 3
        ? Cesium.Color.fromBytes(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), c.length >= 4 ? Math.round(c[3]) : 255)
        : undefined
    if (sym.type === 'esriSMS') {
      return { markerColor: toColor(sym.color), markerSize: sym.size }
    }
    if (sym.type === 'esriSLS') {
      return { stroke: toColor(sym.color), strokeWidth: sym.width }
    }
    if (sym.type === 'esriSFS') {
      return {
        fill: toColor(sym.color),
        stroke: sym.outline ? toColor(sym.outline.color) : undefined,
        strokeWidth: sym.outline?.width,
      }
    }
    return null
  } catch {
    return null
  }
}



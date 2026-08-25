import * as Cesium from 'cesium'
import { SAFETY } from './loadSafety'

// 网络请求超时（毫秒）：慢速服务不阻塞交互
const FETCH_TIMEOUT = 15000

/** 组合传入的取消信号与超时信号 */
export function withFetchTimeout(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]) : AbortSignal.timeout(FETCH_TIMEOUT)
}

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
  /** WFS/OGC 图层或集合名称 */
  name?: string
  typeName?: string
  collectionId?: string
  /** VectorTile 图层引用的默认样式（styleUrl），用于客户端解码/着色 */
  styleUrl?: string
  /** 内嵌要素集 / 分组层（group）内部携带子图层或图层定义 */
  layerDefinition?: Record<string, unknown>
  /** WMTS 的 tileMatrixSet 等配置 */
  tileMatrixSet?: string
  tileMatrixSetID?: string
  style?: string
  format?: string
}

function layerKind(l: WebLayer): string {
  return l.type || l.layerType || ''
}

/** 通过本地代理拉取 Web Map JSON（支持 AbortSignal 取消） */
export async function fetchWebmap(itemId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const r = await fetch(`/sharing/rest/content/items/${itemId}/data?f=json`, { signal: withFetchTimeout(signal) })
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
    const r = await fetch(`${base}?f=json`, { signal: withFetchTimeout() })
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
export function providerForDynamicMapServer(url: string): Cesium.ImageryProvider {
  const base = url.replace(/\/?$/, '')
  const exportUrl =
    base +
    '/export?bbox={westDegrees},{southDegrees},{eastDegrees},{northDegrees}' +
    '&bboxSR=4326&imageSR=4326&size={width},{height}&format=png&transparent=true&f=image'
  const opts: Cesium.UrlTemplateImageryProvider.ConstructorOptions = {
    url: exportUrl,
    // export URL 明确使用 bboxSR/imageSR=4326，必须匹配 GeographicTilingScheme。
    tilingScheme: new Cesium.GeographicTilingScheme(),
    // 动态 export 也限制最高级别，避免高 zoom 大尺寸图像风暴
    maximumLevel: SAFETY.IMAGERY_MAX_LEVEL,
  }
  return new Cesium.UrlTemplateImageryProvider(opts)
}

function wmtsLayerName(l: WebLayer): string | undefined {
  if (l.layerName) return l.layerName
  if (Array.isArray(l.layers) && l.layers.length > 0) {
    return (l.layers[0] as { name?: string }).name
  }
  return undefined
}

/** WMTS：用直接配置构造；缺图层名返回 null */
export function providerForWmts(layer: WebLayer): Cesium.ImageryProvider | null {
  const url = layer.url || ''
  const name = wmtsLayerName(layer)
  if (!name) return null
  return new Cesium.WebMapTileServiceImageryProvider({
    url,
    layer: name,
    style: layer.style || '',
    format: layer.format || 'image/png',
    tileMatrixSetID: layer.tileMatrixSetID || layer.tileMatrixSet || 'default028mm',
    maximumLevel: SAFETY.IMAGERY_MAX_LEVEL,
  })
}

export async function providerForWebLayer(layer: WebLayer): Promise<Cesium.ImageryProvider | null> {
  const t = layerKind(layer)
  const url = layer.url || ''
  // 按 URL 判断 MapServer/ImageServer（兼容 layerType 为 ArcGISTiledMapServiceLayer 等）
  if (url && /\/MapServer\/?$|\/ImageServer\/?$/i.test(url)) {
    const crs = await detectMapService(url)
    if (crs && !crs.tiled) return providerForDynamicMapServer(url)
    return providerForTiledMap(url)
  }
  if (/MapServer|ImageServer/i.test(t) && url) {
    const crs = await detectMapService(url)
    if (crs && !crs.tiled) return providerForDynamicMapServer(url)
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
    return new Cesium.WebMapServiceImageryProvider({ url, layers: name, maximumLevel: SAFETY.IMAGERY_MAX_LEVEL })
  }
  // WMTS：OGC 瓦片，需图层名
  if (/WMTSLayer|WMTS/i.test(t) && url) {
    return providerForWmts(layer)
  }
  // WebTiledLayer：XYZ 模板
  if (/WebTiledLayer/i.test(t) && layer.urlTemplate) {
    return new Cesium.UrlTemplateImageryProvider({ url: layer.urlTemplate, maximumLevel: SAFETY.IMAGERY_MAX_LEVEL })
  }
  if (t === 'OpenStreetMap') {
    return new Cesium.UrlTemplateImageryProvider({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    })
  }
  if (layer.urlTemplate) {
    return new Cesium.UrlTemplateImageryProvider({ url: layer.urlTemplate, maximumLevel: SAFETY.IMAGERY_MAX_LEVEL })
  }
  return null
}

export interface FeatureStyle {
  markerColor?: Cesium.Color
  markerSize?: number
  stroke?: Cesium.Color
  strokeWidth?: number
  fill?: Cesium.Color
}

export function isFeatureLayer(layer: WebLayer): boolean {
  return /FeatureLayer|FeatureServer/i.test(layerKind(layer))
}

export function isGeoJsonLayer(layer: WebLayer): boolean {
  return /GeoJSONLayer/i.test(layerKind(layer))
}

export function isFeatureCollectionLayer(layer: WebLayer): boolean {
  return /featureCollection|Feature Collection/i.test(layerKind(layer)) || !!layer.layerDefinition?.featureCollection
}

export function isKmlLayer(layer: WebLayer): boolean {
  return /KMLLayer|KML/i.test(layerKind(layer))
}
export function isVectorTileLayer(layer: WebLayer): boolean {
  return /VectorTileLayer/i.test(layerKind(layer))
}

export function isSceneLayer(layer: WebLayer): boolean {
  return /SceneLayer|ArcGISSceneServiceLayer|ArcGISSceneLayer|I3S|IntegratedMesh|PointCloud|3DObject|BuildingScene/i.test(layerKind(layer))
}

export function is3dTilesLayer(layer: WebLayer): boolean {
  return /3DTiles|Cesium3DTiles|Tileset/i.test(layerKind(layer)) || /tileset\.json/i.test(layer.url ?? '')
}

export function isWfsLayer(layer: WebLayer): boolean {
  return /WFS|OGCFeatureServer|OGCFeatureService/i.test(layerKind(layer))
}

export function isCsvLayer(layer: WebLayer): boolean {
  return /CSVLayer/i.test(layerKind(layer))
}



/** 要素服务 → GeoJSON（按 resultOffset 分页拉取，上限 limit 防止超大服务拖垮页面） */
// ArcGIS JSON (f=json) query -> GeoJSON FeatureCollection (Point/Line/Polygon).
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

/** FeatureServer -> GeoJSON (paged, capped so huge services don't drag the page) */
export async function fetchFeatureGeoJSON(url: string, limit: number = SAFETY.MAX_FEATURES, signal?: AbortSignal): Promise<unknown> {
  const base = url.replace(/\/+$/, '')
  let pageSize = 2000
  let layerId = 0
  try {
    const meta = await fetch(`${base}?f=json`, { signal: withFetchTimeout() })
    if (meta.ok) {
      const m = (await meta.json()) as { maxRecordCount?: number; layers?: Array<{ id?: number }> }
      if (typeof m.maxRecordCount === 'number' && m.maxRecordCount > 0 && m.maxRecordCount <= 4000) pageSize = m.maxRecordCount
      const firstLayer = m.layers?.find((l) => typeof l.id === 'number')
      if (firstLayer) layerId = firstLayer.id as number
    }
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
    const r = await fetch(geojsonUrl, { signal: withFetchTimeout(signal) })
    let feats: unknown[]
    if (r.ok) {
      const gj = (await r.json()) as { features?: unknown[] }
      feats = gj.features ?? []
    } else {
      const jsonUrl = `${base}/${layerId}/query?where=1%3D1&f=json&outFields=*&outSR=4326&resultOffset=${offset}&resultRecordCount=${pageSize}`
      const rj = await fetch(jsonUrl, { signal: withFetchTimeout(signal) })
      if (!rj.ok) throw new Error('要素服务查询失败')
      const jj = (await rj.json()) as { features?: Array<{ attributes?: Record<string, unknown>; geometry?: unknown }>; error?: { message?: string } }
      if (jj.error) throw new Error('要素服务查询失败：' + (jj.error.message ?? ''))
      feats = arcgisQueryToFeatureCollection(jj).features
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

export async function fetchFeatureRenderer(url: string): Promise<Record<string, unknown> | null> {
  const base = url.replace(/\/?$/, '')
  try {
    const r = await fetch(base + '?f=json', { signal: withFetchTimeout() })
    if (!r.ok) return null
    const j = (await r.json()) as { drawingInfo?: { renderer?: Record<string, unknown> } }
    const renderer = j.drawingInfo?.renderer
    return renderer && typeof renderer === 'object' ? renderer : null
  } catch {
    return null
  }
}

export async function fetchFeatureStyle(url: string): Promise<FeatureStyle | null> {
  const base = url.replace(/\/?$/, '')
  try {
    const r = await fetch(`${base}?f=json`, { signal: withFetchTimeout() })
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

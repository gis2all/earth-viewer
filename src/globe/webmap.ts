import * as Cesium from 'cesium'
import { SAFETY } from './loadSafety'
import {
  detectMapService,
  fetchFeatureGeoJSON,
  fetchFeatureRenderer,
  fetchWebmap,
  type MapServiceInfo,
} from '../service/repository'
import {
  isCsvInput,
  isFeatureCollectionInput,
  isFeatureInput,
  isGeoJsonInput,
  isKmlInput,
  isSceneInput,
  is3dTilesInput,
  isVectorTileInput,
  isWfsInput,
} from '../domain/registry'

// 网络请求超时（毫秒）：慢速服务不阻塞交互
const FETCH_TIMEOUT = 15000

/** 组合传入的取消信号与超时信号 */
export function withFetchTimeout(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]) : AbortSignal.timeout(FETCH_TIMEOUT)
}

// 底图影像：World Imagery (WGS84, EPSG:4326) 瓦片，覆盖到 ±90°（与官方 Imagery Hybrid (WGS84) 一致）
export const WORLD_IMAGERY_WGS84_TILES =
  'https://wi.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
// 矢量标注：官方 Hybrid Reference Layer 样式（Imagery Hybrid 的标注层），瓦片走 World_Basemap_v2（Web Mercator）
// MapLibre 当前不支持 GCS 瓦片的 equirectangular 投影，故用 Mercator 版；极区 ±85° 以上无标注，影像仍由 WGS84 底图覆盖
export const WORLD_VECTOR_LABELS_STYLE_URL =
  'https://www.arcgis.com/sharing/rest/content/items/30d6b8271e1849cd9c3042060001f425/resources/styles/root.json'

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

/** 通过本地代理拉取 Web Map JSON（实现见 service/repository.ts）。 */
export { fetchWebmap }

function mapServerTileUrl(url: string): string {
  return url.replace(/\/?$/, '/tile/{z}/{y}/{x}')
}

export type { MapServiceInfo }

/** 服务坐标系探测（实现见 service/repository.ts，带 CRS_CACHE）。 */
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

// M1 W1.2：判定逻辑收敛到 domain/registry（纯函数），这里保留导出别名保持兼容；
// M3 后随 GlobeViewer 瘦身清理。
export const isFeatureLayer = (layer: WebLayer): boolean => isFeatureInput(layer)

export const isGeoJsonLayer = (layer: WebLayer): boolean => isGeoJsonInput(layer)

export const isFeatureCollectionLayer = (layer: WebLayer): boolean => isFeatureCollectionInput(layer)

export const isKmlLayer = (layer: WebLayer): boolean => isKmlInput(layer)

export const isVectorTileLayer = (layer: WebLayer): boolean => isVectorTileInput(layer)

export const isSceneLayer = (layer: WebLayer): boolean => isSceneInput(layer)

export const is3dTilesLayer = (layer: WebLayer): boolean => is3dTilesInput(layer)

export const isWfsLayer = (layer: WebLayer): boolean => isWfsInput(layer)

export const isCsvLayer = (layer: WebLayer): boolean => isCsvInput(layer)



/** 要素服务 → GeoJSON / renderer（实现见 service/repository.ts）。 */
export { fetchFeatureGeoJSON, fetchFeatureRenderer }

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

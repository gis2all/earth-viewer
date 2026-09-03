/**
 * Domain 层 WebLayer 精细分类（W4.4 收敛）。
 * 零依赖：kind 判定是纯字符串/结构匹配，不引用 Cesium / MapLibre / globe。
 * 用途：
 * - 单一分类入口（classifyWebLayerKind）：layerAssessment / loadSafety /
 *   webmapProviders / webLayerRenderer 共用同一套“显式字段优先、URL 回退”规则；
 * - is*Input 是渲染分发的兼容视图；
 * - layerKindOf 是 LayerKind 粗分类兼容映射。
 * 这里只做分类，不引入全局注册表，也不做 LayerAdapter。
 */
import type { LayerKind } from './types'

/** 判定只依赖的结构字段；WebLayer 等任意富类型均可结构化赋值给本类型。 */
export interface LayerDescriptor {
  type?: string
  layerType?: string
  url?: string
  urlTemplate?: string
  layerDefinition?: Record<string, unknown>
}

/** WebLayer 内层字段统一优先级：layerType 是 webmap 官方字段，type 只作旧输入兼容。 */
export function layerTypeOf(input: LayerDescriptor): string {
  return input.layerType || input.type || ''
}

/**
 * 渲染用精细类型。LayerKind 面向 ArcGIS Online 搜索白名单，WebLayerKind 面向
 * webmap 内层实际渲染分支，因此保留 WebTiled / OpenStreetMap / urlTemplate /
 * 暂不支持类型等 LayerKind 之外的细粒度。
 */
export type WebLayerKind =
  | 'map'
  | 'image'
  | 'wms'
  | 'wmts'
  | 'vectorTile'
  | 'featureCollection'
  | 'scene'
  | '3dTiles'
  | 'wfs'
  | 'csv'
  | 'feature'
  | 'geojson'
  | 'kml'
  | 'webtiled'
  | 'osm'
  | 'urlTemplate'
  | 'stream'
  | 'georss'
  | 'knowledgeGraph'

/**
 * 显式类型规则。判定按渲染优先级排列，避免“FeatureServer”被 feature 抢占 WFS、
 * “WMS”覆盖 WMTS 等误判。
 */
const EXPLICIT_KIND_RULES: ReadonlyArray<readonly [WebLayerKind, RegExp]> = [
  ['featureCollection', /featureCollection|Feature Collection/i],
  ['vectorTile', /VectorTileLayer/i],
  ['scene', /SceneLayer|ArcGISSceneServiceLayer|ArcGISSceneLayer|I3S|IntegratedMesh|PointCloud|3DObject|BuildingScene/i],
  ['3dTiles', /3DTiles|Cesium3DTiles|Tileset/i],
  ['wfs', /WFS|OGCFeatureServer|OGCFeatureService/i],
  ['csv', /CSVLayer/i],
  ['feature', /FeatureLayer|FeatureServer/i],
  ['geojson', /GeoJSONLayer/i],
  ['kml', /KMLLayer|KML/i],
  ['wms', /WMSLayer|WMS/i],
  ['wmts', /WMTSLayer|WMTS/i],
  ['webtiled', /WebTiledLayer/i],
  ['osm', /OpenStreetMap/i],
  ['map', /MapServer|MapService/i],
  ['image', /ImageServer|ImageService/i],
  ['stream', /StreamLayer/i],
  ['georss', /GeoRSSLayer/i],
  ['knowledgeGraph', /KnowledgeGraph/i],
]

function explicitKind(raw: string): WebLayerKind | null {
  for (const [kind, re] of EXPLICIT_KIND_RULES) {
    if (re.test(raw)) return kind
  }
  return null
}

function hasEmbeddedFeatureCollection(input: LayerDescriptor): boolean {
  return !!input.layerDefinition?.featureCollection
}

function urlFallbackKind(url: string): WebLayerKind | null {
  if (/tileset\.json/i.test(url)) return '3dTiles'
  if (/\/MapServer\/?$/i.test(url)) return 'map'
  if (/\/ImageServer\/?$/i.test(url)) return 'image'
  if (/\/wms(?:\?|$)/i.test(url)) return 'wms'
  if (/\/FeatureServer(?:\/|$)/i.test(url)) return 'feature'
  if (/\/wfs(?:\/|$)/i.test(url)) return 'wfs'
  return null
}

/**
 * 单一图层分类入口（W4.4 收敛）：
 * 1. layerType / type 显式字段优先，冲突时不再让 URL 覆盖；
 * 2. 无显式类型时，内嵌 FeatureCollection / URL / urlTemplate 依次回退。
 */
export function classifyWebLayerKind(input: LayerDescriptor): WebLayerKind | null {
  const explicit = explicitKind(layerTypeOf(input))
  if (explicit) return explicit
  if (hasEmbeddedFeatureCollection(input)) return 'featureCollection'
  const url = input.url ?? ''
  const fromUrl = urlFallbackKind(url)
  if (fromUrl) return fromUrl
  if (input.urlTemplate) return 'urlTemplate'
  return null
}

// —— is*Input 兼容视图：全部委托给上面的单一分类，不再各自维护正则 ——

export function isFeatureInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'feature'
}

export function isGeoJsonInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'geojson'
}

export function isFeatureCollectionInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'featureCollection'
}

export function isKmlInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'kml'
}

export function isVectorTileInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'vectorTile'
}

export function isSceneInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'scene'
}

export function is3dTilesInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === '3dTiles'
}

export function isWfsInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'wfs'
}

export function isCsvInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'csv'
}

export function isMapInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'map'
}

export function isImageInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'image'
}

export function isWmsInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'wms'
}

export function isWmtsInput(input: LayerDescriptor): boolean {
  return classifyWebLayerKind(input) === 'wmts'
}

/**
 * LayerKind 兼容视图：按渲染分发顺序映射精细类型。
 * webmap/webscene 是容器，不由图层结构推断（由上层按 item type 显式匹配），返回 null。
 */
export function layerKindOf(input: LayerDescriptor): LayerKind | null {
  switch (classifyWebLayerKind(input)) {
    case 'map': return 'map'
    case 'image': return 'image'
    case 'wms': return 'wms'
    case 'wmts': return 'wmts'
    case 'vectorTile': return 'vector'
    case 'featureCollection': return 'feature'
    case 'scene':
    case '3dTiles': return 'scene'
    case 'wfs': return 'wfs'
    case 'csv': return 'csv'
    case 'feature': return 'feature'
    case 'geojson': return 'geojson'
    case 'kml': return 'kml'
    default: return null
  }
}

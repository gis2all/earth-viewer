/**
 * Domain 层：零依赖的图层领域类型。
 * LayerKind 白名单对齐 ArcGIS Online 13 类可搜索类型（src/domain/itemTypes.ts）。
 */
export const LAYER_KINDS = [
  // 容器：整图加载
  'webmap',
  'webscene',
  // 服务类
  'map',
  'feature',
  'image',
  'scene',
  'vector',
  'wms',
  'wmts',
  'wfs',
  // 文件类
  'kml',
  'geojson',
  'csv',
] as const

export type LayerKind = (typeof LAYER_KINDS)[number]

/** 加载风险分级（与 loadSafety.LoadRisk 对齐，M1 后收敛到此处）。 */
export type RiskLevel = 'light' | 'medium' | 'heavy'

/** Web 图层统一结构（webmap 内层 / 搜索结果项映射后的富类型）。 */
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

/** 通用要素样式（KML 转换 / Feature Service renderer 共用，与具体引擎无关）。 */
export interface FeatureStyleSpec {
  markerColor?: [number, number, number, number]
  markerSize?: number
  stroke?: [number, number, number, number]
  strokeWidth?: number
  fill?: [number, number, number, number]
}

/** 用户大概位置（服务端按 IP 估算的国家质心；src/service/userLocation.ts 获取并缓存）。 */
export interface UserHome {
  lat: number
  lon: number
}

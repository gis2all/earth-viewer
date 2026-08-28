/**
 * Domain 层：零依赖的图层领域类型。
 * LayerKind 白名单对齐 ArcGIS Online 13 类可搜索类型（src/globe/itemTypes.ts）。
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

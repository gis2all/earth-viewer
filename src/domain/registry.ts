/**
 * Domain 层图层注册表（W1.2）。
 * 零依赖：kind 判定是纯字符串/结构匹配，不引用 Cesium / MapLibre / globe。
 * 用途：
 * - globe/renderWebmap.ts 的渲染分支判定直接引用这里的 is*Input（W4.3 起无别名）；
 * - M2 起真实 LayerAdapter 通过 LAYER_REGISTRY.register() 注册（当前为后备工作项），
 *   新增图层类型只需注册 adapter + 契约测试（adapter.contract.test.ts 自动覆盖）。
 */
import type { LayerAdapter, LayerInput } from './adapter'
import type { LayerKind } from './types'

/** 判定只依赖的结构字段；WebLayer 等任意富类型均可结构化赋值给本类型。 */
export interface LayerDescriptor {
  type?: string
  layerType?: string
  url?: string
  layerDefinition?: Record<string, unknown>
}

/** 与 webmap.ts layerKind() 一致：type 优先，其次 layerType。 */
function rawKind(input: LayerDescriptor): string {
  return input.type || input.layerType || ''
}

// —— 以下 8 个判定与 webmap.ts 原 is*Layer 正则完全一致（行为不得改变）——

export function isFeatureInput(input: LayerDescriptor): boolean {
  return /FeatureLayer|FeatureServer/i.test(rawKind(input))
}

export function isGeoJsonInput(input: LayerDescriptor): boolean {
  return /GeoJSONLayer/i.test(rawKind(input))
}

export function isFeatureCollectionInput(input: LayerDescriptor): boolean {
  return (
    /featureCollection|Feature Collection/i.test(rawKind(input)) ||
    !!input.layerDefinition?.featureCollection
  )
}

export function isKmlInput(input: LayerDescriptor): boolean {
  return /KMLLayer|KML/i.test(rawKind(input))
}

export function isVectorTileInput(input: LayerDescriptor): boolean {
  return /VectorTileLayer/i.test(rawKind(input))
}

export function isSceneInput(input: LayerDescriptor): boolean {
  return /SceneLayer|ArcGISSceneServiceLayer|ArcGISSceneLayer|I3S|IntegratedMesh|PointCloud|3DObject|BuildingScene/i.test(
    rawKind(input)
  )
}

export function is3dTilesInput(input: LayerDescriptor): boolean {
  return (
    /3DTiles|Cesium3DTiles|Tileset/i.test(rawKind(input)) ||
    /tileset\.json/i.test(input.url ?? '')
  )
}

export function isWfsInput(input: LayerDescriptor): boolean {
  return /WFS|OGCFeatureServer|OGCFeatureService/i.test(rawKind(input))
}

export function isCsvInput(input: LayerDescriptor): boolean {
  return /CSVLayer/i.test(rawKind(input))
}

// —— 服务类（原 providerForWebLayer 的 URL/类型判定，收敛为纯分类）——

export function isMapInput(input: LayerDescriptor): boolean {
  const url = input.url ?? ''
  return /\/MapServer\/?$/i.test(url) || /MapServer|MapService/i.test(rawKind(input))
}

export function isImageInput(input: LayerDescriptor): boolean {
  const url = input.url ?? ''
  return /\/ImageServer\/?$/i.test(url) || /ImageServer|ImageService/i.test(rawKind(input))
}

export function isWmsInput(input: LayerDescriptor): boolean {
  return /WMSLayer|WMS/i.test(rawKind(input))
}

export function isWmtsInput(input: LayerDescriptor): boolean {
  return /WMTSLayer|WMTS/i.test(rawKind(input))
}

/**
 * 完整分类：按 GlobeViewer 渲染分发顺序（map/image/wms/wmts → vector →
 * featureCollection → scene → 3dtiles → wfs → csv → feature → geojson → kml）。
 * webmap/webscene 是容器，不由图层结构推断（由上层按 item type 显式匹配），返回 null。
 */
export function layerKindOf(input: LayerDescriptor): LayerKind | null {
  if (isMapInput(input)) return 'map'
  if (isImageInput(input)) return 'image'
  if (isWmsInput(input)) return 'wms'
  if (isWmtsInput(input)) return 'wmts'
  if (isVectorTileInput(input)) return 'vector'
  if (isFeatureCollectionInput(input)) return 'feature'
  if (isSceneInput(input)) return 'scene'
  if (is3dTilesInput(input)) return 'scene'
  if (isWfsInput(input)) return 'wfs'
  if (isCsvInput(input)) return 'csv'
  if (isFeatureInput(input)) return 'feature'
  if (isGeoJsonInput(input)) return 'geojson'
  if (isKmlInput(input)) return 'kml'
  return null
}

export interface LayerRegistry {
  register(adapter: LayerAdapter): void
  get(kind: LayerKind): LayerAdapter | undefined
  /** 按注册顺序返回所有 matches(input) 为真的 adapter。 */
  matchAll(input: LayerInput): LayerAdapter[]
  kinds(): LayerKind[]
}

export function createRegistry(): LayerRegistry {
  const adapters = new Map<LayerKind, LayerAdapter>()
  const order: LayerKind[] = []
  return {
    register(adapter) {
      if (adapters.has(adapter.kind)) {
        throw new Error(`LAYER_REGISTRY: ${adapter.kind} 已注册`)
      }
      adapters.set(adapter.kind, adapter)
      order.push(adapter.kind)
    },
    get(kind) {
      return adapters.get(kind)
    },
    matchAll(input) {
      return order
        .map((kind) => adapters.get(kind)!)
        .filter((adapter) => adapter.matches(input))
    },
    kinds() {
      return [...order]
    },
  }
}

/** 全局注册表：M2 起由各 adapter 模块在此登记。 */
export const LAYER_REGISTRY = createRegistry()

import type { WebLayer } from './webmap'

export type LayerSupport = 'full' | 'partial' | 'none'
export type LayerRole = 'basemap' | 'overlay' | 'business'

export interface LayerAssessment {
  title?: string
  url?: string
  kind: string
  role: LayerRole
  support: LayerSupport
  reason?: string
}

export interface WebmapAssessment {
  /** 能否添加（有可渲染的主底图或业务图层） */
  renderable: boolean
  /** 渲染保真度：full=全部可渲染 / partial=部分图层不支持 / none=无可渲染 */
  fidelity: 'full' | 'partial' | 'none'
  /** 不可渲染或降级的原因 */
  reason?: string
  layers: LayerAssessment[]
}

// 辅助/参考层：只作为叠加（灰度阴影、边界标注、交通参考等），不能单独作为主内容
const OVERLAY_URL_RE =
  /World_Hillshade|World_Boundaries_and_Places|World_Transportation|World_Reference|World_Terrain_Base|World_Shaded_Relief/i

function kindOf(l: WebLayer): string {
  return l.layerType || l.type || ''
}

/** 评估单个图层的支持度（能力表：类型 → Cesium 支持情况） */
export function classifyLayer(l: WebLayer, role: LayerRole): LayerAssessment {
  const kind = kindOf(l)
  const url = l.url || ''
  const base: LayerAssessment = { title: l.title, url, kind, role, support: 'full' }

  // 矢量切片：ArcGIS MVT，Cesium 无原生渲染
  if (/VectorTileLayer/i.test(kind)) {
    return { ...base, support: 'none', reason: '矢量切片图层，Cesium 暂不支持' }
  }
  // 3D 场景图层
  if (/SceneLayer|ArcGISSceneServiceLayer|3D Scene/i.test(kind)) {
    return { ...base, support: 'none', reason: '3D 场景图层，暂不支持' }
  }
  // 无服务地址（如纯 styleUrl 的图层）
  if (!url) {
    return { ...base, support: 'none', reason: '图层缺少可加载的服务地址' }
  }
  // 能力表（分层级）：
  // - full：影像瓦片（MapServer/ImageServer）、基础 WMS/KML —— 原生渲染
  // - partial：FeatureLayer / FeatureServer / GeoJSONLayer —— 降级为 GeoJSON，仅映射 SimpleRenderer 样式、条数有限
  // - none：VectorTile / Scene / 其他 —— 不支持
  // 注意：ArcGIS webmap 里 WMS/KML 图层的 type 是 "WMS"/"KML"（也可能 "WMSLayer"/"KMLLayer"）
  const isTile =
    /\/MapServer\/?$|\/ImageServer\/?$/i.test(url)
  const isWms = /WMSLayer|^WMS$/i.test(kind)
  const isKml = /KMLLayer|^KML$/i.test(kind)
  const isFeature = /FeatureLayer|FeatureServer|GeoJSONLayer/i.test(kind)
  if (isTile) {
    return base
  }
  if (isWms) {
    // WMS 必须能确定图层名（layerName 或 layers 数组/字符串），否则 provider 无法构造
    const hasName =
      !!l.layerName || Array.isArray(l.layers) || typeof l.layers === 'string'
    if (!hasName) {
      return { ...base, support: 'partial', reason: '缺少 WMS 图层名，无法渲染' }
    }
    return base
  }
  if (isKml) {
    return base
  }
  if (isFeature) {
    return {
      ...base,
      support: 'partial',
      reason: '要素图层降级为 GeoJSON 渲染（仅映射 SimpleRenderer 样式，条数受限）',
    }
  }
  return { ...base, support: 'none', reason: '图层类型暂不支持：' + (kind || url) }
}

/** 返回应当渲染的图层：支持（full）且非辅助层（overlay）——让渲染层消费同一份评估结果 */
export function renderableLayersFromWebmap(wm: Record<string, unknown>): WebLayer[] {
  const bmLayers = ((wm.baseMap as { baseMapLayers?: WebLayer[] } | undefined)?.baseMapLayers) ?? []
  const opLayers = (wm.operationalLayers as WebLayer[] | undefined) ?? []
  const all: { l: WebLayer; role: LayerRole }[] = [
    ...bmLayers.map((l) => ({
      l,
      role: (OVERLAY_URL_RE.test(l.url ?? '') ? 'overlay' : 'basemap') as LayerRole,
    })),
    ...opLayers.map((l) => ({ l, role: 'business' as LayerRole })),
  ]
  return all
    .filter(({ l, role }) => {
      const a = classifyLayer(l, role)
      return role !== 'overlay' && (a.support === 'full' || a.support === 'partial')
    })
    .map(({ l }) => l)
}

/** 整体评估一个 webmap 在 Cesium 下的渲染能力（统一入口，替代散落的特判） */
export function assessWebmap(wm: Record<string, unknown>): WebmapAssessment {
  const bmLayers = ((wm.baseMap as { baseMapLayers?: WebLayer[] } | undefined)?.baseMapLayers) ?? []
  const opLayers = (wm.operationalLayers as WebLayer[] | undefined) ?? []

  const layers: LayerAssessment[] = [
    ...bmLayers.map((l) => classifyLayer(l, OVERLAY_URL_RE.test(l.url ?? '') ? 'overlay' : 'basemap')),
    ...opLayers.map((l) => classifyLayer(l, 'business')),
  ]

  // 主内容 = 可渲染的主底图或业务图层（overlay 只做叠加，不能当主内容；full/partial 都可渲染）
  const mainLayers = layers.filter(
    (l) =>
      (l.role === 'basemap' || l.role === 'business') &&
      (l.support === 'full' || l.support === 'partial')
  )
  const renderable = mainLayers.length > 0

  const degradedLayers = layers.filter((l) => l.support === 'partial' || l.support === 'none')
  const fidelity = renderable ? (degradedLayers.length > 0 ? 'partial' : 'full') : 'none'

  let reason: string | undefined
  if (!renderable) {
    const first = layers.find((l) => l.reason)
    reason = first?.reason ?? '无可渲染图层'
  }

  return { renderable, fidelity, reason, layers }
}

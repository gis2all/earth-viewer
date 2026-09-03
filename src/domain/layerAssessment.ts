import type { WebLayer } from './types'
import { DEFAULT_APP_CONFIG } from './config'
import { classifyWebLayerKind } from './webLayerKind'

export type LayerSupport = 'full' | 'partial' | 'none'
export const MAX_BUSINESS_LAYERS = DEFAULT_APP_CONFIG.maxBusinessLayers
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

function isGroupLayer(l: WebLayer): boolean {
  return /GroupLayer/i.test(kindOf(l)) && Array.isArray((l as WebLayer & { layers?: WebLayer[] }).layers)
}

function groupChildren(l: WebLayer): WebLayer[] {
  return ((l as WebLayer & { layers?: WebLayer[] }).layers) ?? []
}

function baseMapRole(l: WebLayer): LayerRole {
  return OVERLAY_URL_RE.test(l.url ?? '') ? 'overlay' : 'basemap'
}

/**
 * 评估单个图层的支持度（能力表：类型 → Cesium 支持情况）。
 * full=原生影像/场景渲染；partial=需降级（GeoJSON/MVT解码/I3S/3DTiles）；none=暂不支持。
 */
export function classifyLayer(l: WebLayer, role: LayerRole): LayerAssessment {
  const kind = kindOf(l)
  const url = (l.url || '').trim()
  const classified = classifyWebLayerKind(l)
  const base: LayerAssessment = { title: l.title, url, kind, role, support: 'full' }

  // 无 url：样式驱动的 VectorTile、内嵌 featureCollection、模板类图层仍可尝试渲染
  if (!url) {
    if (classified === 'vectorTile' && l.styleUrl) {
      return { ...base, support: 'full', reason: '矢量瓦片用 MapLibre 按官方样式渲染' }
    }
    if (classified === 'featureCollection' || l.layerDefinition) {
      return { ...base, support: 'partial', reason: '内嵌要素集按 GeoJSON 渲染' }
    }
    if ((classified === 'webtiled' && l.urlTemplate) || classified === 'osm' || classified === 'urlTemplate') {
      return base
    }
    return { ...base, support: 'none', reason: '图层缺少可加载的服务地址' }
  }

  switch (classified) {
    case 'vectorTile':
      return { ...base, support: 'full', reason: '矢量瓦片用 MapLibre 按官方样式渲染' }
    case 'scene':
      return { ...base, support: 'partial', reason: '3D 场景图层用 I3S 渲染' }
    case '3dTiles':
      return { ...base, support: 'partial', reason: '3D Tiles 用 Cesium3DTileset 渲染' }
    case 'stream':
    case 'georss':
    case 'knowledgeGraph':
      return { ...base, support: 'none', reason: '流/Feed/知识图谱图层暂不支持' }
    case 'wfs':
      return { ...base, support: 'partial', reason: 'WFS 要素按 GeoJSON 渲染' }
    case 'geojson':
      return { ...base, support: 'partial', reason: 'GeoJSON 图层直接渲染' }
    case 'csv':
      return { ...base, support: 'partial', reason: 'CSV 解析为点要素渲染' }
    case 'map':
    case 'image':
      return base
    case 'wms': {
      // WMS 必须能确定图层名（layerName 或 layers 数组/字符串），否则 provider 无法构造
      const hasName = !!l.layerName || Array.isArray(l.layers) || typeof l.layers === 'string'
      return hasName
        ? base
        : { ...base, support: 'partial', reason: '缺少 WMS 图层名，无法渲染' }
    }
    case 'wmts': {
      const hasCfg = !!l.layerName || !!l.urlTemplate || !!l.layers
      return hasCfg
        ? base
        : { ...base, support: 'partial', reason: '缺少 WMTS 图层配置' }
    }
    case 'kml':
    case 'webtiled':
    case 'osm':
    case 'urlTemplate':
      return base
    case 'feature':
      return {
        ...base,
        support: 'partial',
        reason: '要素图层按 GeoJSON 渲染（映射样式，条数受限）',
      }
    default:
      break
  }
  return { ...base, support: 'none', reason: '图层类型暂不支持：' + (kind || url) }
}

/** 展平（含分组层）为 [{l, role}]，角色按所在集合推断 */
function collectLayers(wm: Record<string, unknown>): { l: WebLayer; role: LayerRole }[] {
  const bmLayers = ((wm.baseMap as { baseMapLayers?: WebLayer[] } | undefined)?.baseMapLayers) ?? []
  const opLayers = (wm.operationalLayers as WebLayer[] | undefined) ?? []
  const out: { l: WebLayer; role: LayerRole }[] = []

  const push = (l: WebLayer, role: LayerRole) => {
    if (isGroupLayer(l)) {
      for (const sub of groupChildren(l)) push(sub, role)
      return
    }
    out.push({ l, role })
  }

  for (const l of bmLayers) push(l, baseMapRole(l))
  for (const l of opLayers) push(l, 'business')
  return out
}

/** 返回应当渲染的图层：支持（full/partial）且非辅助层（overlay），并展平分组层；业务层限制为 MAX_BUSINESS_LAYERS 个，防止重 webmap 内存/渲染崩溃。 */
export function renderableLayersFromWebmap(wm: Record<string, unknown>): WebLayer[] {
  const result: WebLayer[] = []
  let business = 0
  for (const { l, role } of collectLayers(wm)) {
    const a = classifyLayer(l, role)
    if (role === 'overlay' || (a.support !== 'full' && a.support !== 'partial')) continue
    if (role === 'business') {
      if (business >= MAX_BUSINESS_LAYERS) continue
      business++
    }
    result.push(l)
  }
  return result
}

/** 业务层中可渲染（full/partial）的数量（不受 MAX_BUSINESS_LAYERS 限制），用于计算省略数 */
function businessRenderableCount(wm: Record<string, unknown>): number {
  let n = 0
  for (const { l, role } of collectLayers(wm)) {
    if (role !== 'business') continue
    const a = classifyLayer(l, role)
    if (a.support === 'full' || a.support === 'partial') n++
  }
  return n
}

/** 渲染时被 MAX_BUSINESS_LAYERS 省略的业务层数（>0 时应提示"部分图层未渲染"） */
export function skippedBusinessLayers(wm: Record<string, unknown>): number {
  return Math.max(0, businessRenderableCount(wm) - MAX_BUSINESS_LAYERS)
}

/** 整体评估一个 webmap 在 Cesium 下的渲染能力（统一入口） */
export function assessWebmap(wm: Record<string, unknown>): WebmapAssessment {
  const assessments = collectLayers(wm).map(({ l, role }) => classifyLayer(l, role))

  // 主内容 = 可渲染的主底图或业务图层（overlay 只做叠加，不能当主内容；full/partial 都可渲染）
  const mainLayers = assessments.filter(
    (l) =>
      (l.role === 'basemap' || l.role === 'business') &&
      (l.support === 'full' || l.support === 'partial')
  )
  const renderable = mainLayers.length > 0

  const degradedLayers = assessments.filter((l) => l.support === 'partial' || l.support === 'none')
  const fidelity = renderable ? (degradedLayers.length > 0 ? 'partial' : 'full') : 'none'

  let reason: string | undefined
  if (!renderable) {
    const first = assessments.find((l) => l.reason)
    reason = first?.reason ?? '无可渲染图层'
  }

  return { renderable, fidelity, reason, layers: assessments }
}

/**
 * LayerLoader（W2.2）：纯数据加载管线（预检 → 取数 → 转换 → 预算消费）。
 * - 不做任何 Cesium 对象创建（M3 的 CesiumFacade 负责上球）；
 * - 按 LayerKind 分发到 globe 层协议适配器（ogc/csv/kml），统一走 repository 取数；
 * - 输出纯数据 LoadResult，渲染层据此构造 ImageryLayer / DataSource / Primitive。
 */
import { LayerLoadError, type LayerInput } from '../domain/adapter'
import { LAYER_REGISTRY, layerKindOf } from '../domain/registry'
import { DEFAULT_BUDGET_POLICY, type BudgetPolicy } from '../domain/policy'
import type { LayerKind } from '../domain/types'
import { isWebMapContainer } from '../globe/itemTypes'
import { parseKmlToGeoJSON } from '../globe/kml'
import { assertUrlWithinLimit, consumeFeatureBudget } from '../globe/loadSafety'
import { runViewportProcess } from '../globe/viewport/worker'
import { applyVertexBudget } from '../globe/viewport/budget'
import { fetchCsvGeoJSON } from '../globe/csv'
import { fetchOgcFeatureGeoJSON } from '../globe/ogc'
import { fetchFeatureGeoJSON, fetchWebmap, preflightItem } from './repository'

/** 预算消费结果：镜像 GlobeViewer 内联 consumeBudget 的语义（抽稀 → 截断 → 剩余预算）。 */
export interface BudgetConsumption {
  data: unknown
  capped: boolean
  remaining: number
}

/**
 * 对 GeoJSON 做预算消费：
 * ① 顶点预算：先抽稀再截断（防单个大 polygon 内存爆炸）；
 * ② 要素数预算：限制对象个数；剩余预算不足 → null（略过该层）。
 */
export function applyLayerBudget(
  budget: { remaining: number },
  gj: unknown,
  policy: BudgetPolicy = DEFAULT_BUDGET_POLICY
): BudgetConsumption | null {
  const raw = gj as { type?: string; features?: Record<string, unknown>[] } | null
  const features = Array.isArray(raw?.features) ? raw.features : []
  const vb = applyVertexBudget({ type: 'FeatureCollection', features }, policy.maxRenderVertices)
  const r = consumeFeatureBudget(budget.remaining, vb.data, policy.maxRenderFeatures)
  if (!r) return null
  budget.remaining = r.remaining
  return { data: r.data, capped: vb.capped || r.capped, remaining: r.remaining }
}

export interface LoaderOptions {
  /** 预算策略（默认 DEFAULT_BUDGET_POLICY，与 loadSafety.SAFETY 对齐）。 */
  policy?: BudgetPolicy
  /** 是否执行预检（服务类可用性探测）；默认 true。 */
  preflight?: boolean
}

/** 加载结果：按 LayerKind 分派的纯数据载荷（不含 Cesium 对象）。 */
export type LoadResult =
  | { kind: 'webmap' | 'webscene'; input: LayerInput; data: Record<string, unknown>; preflight: boolean }
  | { kind: 'map' | 'image' | 'wms' | 'wmts' | 'vector' | 'scene'; input: LayerInput; data: { url: string; styleUrl?: string; title?: string }; preflight: boolean }
  | { kind: 'feature' | 'wfs' | 'csv' | 'geojson' | 'kml'; input: LayerInput; data: unknown; capped: boolean; preflight: boolean }

const CONTAINER_KINDS = new Set<LayerKind>(['webmap', 'webscene'])

/** 文件类 / 要素类载荷上限检查（GeoJSON/CSV/KML）。 */
function maxBytesFor(kind: LayerKind, policy: BudgetPolicy): number | undefined {
  if (kind === 'kml') return policy.kmlMaxBytes
  if (kind === 'geojson' || kind === 'csv') return policy.maxFileBytes
  return undefined
}

/**
 * 数据加载管线：
 * 1. preflight：服务类 item 先探测可用性（容器 / 文件类不做，由点开校验兜底）；
 * 2. fetchData：容器走 repository.fetchWebmap；要素/文件走协议适配器；影像类返回源 URL；
 * 3. transform：要素/文件统一 viewport 处理（抽稀/简化）→ 预算消费（截断 + 预算递减）；
 * 4. 输出纯数据 LoadResult。
 */
export async function loadLayerData(
  input: LayerInput,
  signal: AbortSignal,
  opts: LoaderOptions = {}
): Promise<LoadResult> {
  const policy = opts.policy ?? DEFAULT_BUDGET_POLICY
  const kind = kindOf(input)
  const container = isWebMapContainer(input.type ?? input.layerType ?? '')
  if (container && input.webmap) {
    return { kind: 'webmap', input, data: input.webmap, preflight: true }
  }

  // 1. 预检：服务类才有探测意义；容器/文件类不做（点开校验兜底）。
  if (opts.preflight !== false && kind && !CONTAINER_KINDS.has(kind)) {
    const ok = await preflightItem(input as { id: string; type?: string; url?: string }, signal)
    if (!ok) throw new LayerLoadError('network', '服务不可用（预检失败）')
  }

  // 2. 取数
  if (container) {
    const data = await fetchWebmap(input.id, signal)
    return { kind: 'webmap', input, data, preflight: true }
  }
  if (!kind) throw new LayerLoadError('unsupported', `不支持的图层类型：${input.type ?? input.layerType ?? '未知'}`)

  const budget = { remaining: policy.maxTotalFeatures }
  if (kind === 'map' || kind === 'image' || kind === 'wms' || kind === 'wmts' || kind === 'vector' || kind === 'scene') {
    return {
      kind,
      input,
      data: { url: input.url ?? '', styleUrl: (input.layerDefinition as { styleUrl?: string } | undefined)?.styleUrl, title: input.title },
      preflight: true,
    }
  }

  // 要素 / 文件类：协议适配器取数 → 统一转换（viewport + 预算）。
  const maxBytes = maxBytesFor(kind, policy)
  if (maxBytes !== undefined && input.url) await assertUrlWithinLimit(input.url, maxBytes, signal)
  const raw = await fetchDataFor(kind, input, signal)
  const processed = await runViewportProcess({
    geojson: raw,
    maxVertices: policy.maxRenderVertices,
    maxFeatures: policy.maxRenderFeatures,
  })
  const consumed = applyLayerBudget(budget, { type: 'FeatureCollection', features: processed.features }, policy)
  if (!consumed) throw new LayerLoadError('budget', '数据总量过大，已省略该图层')
  return { kind: kind as 'feature' | 'wfs' | 'csv' | 'geojson' | 'kml', input, data: consumed.data, capped: processed.capped || consumed.capped, preflight: true }
}

/** 识别输入图层类型：容器显式匹配；其余委托 domain/registry。 */
export function kindOf(input: LayerInput): LayerKind | null {
  if (isWebMapContainer(input.type ?? input.layerType ?? '')) return input.type?.toLowerCase().includes('scene') ? 'webscene' : 'webmap'
  const matches = LAYER_REGISTRY.matchAll(input)
  // 真实 LayerAdapter 尚未注册（adapter 化是 W4.5 记录的后备工作项）：
  // 注册表无匹配时回退到纯分类函数，保证 W2.2 管线行为不变。
  return matches[0]?.kind ?? layerKindOf(input)
}

async function fetchDataFor(kind: LayerKind, input: LayerInput, signal: AbortSignal): Promise<unknown> {
  const url = input.url
  if (!url) throw new LayerLoadError('network', '图层缺少服务地址')
  if (kind === 'kml') {
    const r = await fetch(url, { signal })
    if (!r.ok) throw new LayerLoadError('network', 'KML 加载失败')
    const text = await r.text()
    return parseKmlToGeoJSON(text)
  }
  if (kind === 'csv') return fetchCsvGeoJSON(url, input as never, signal)
  if (kind === 'wfs') return fetchOgcFeatureGeoJSON(url, input as never, signal)
  if (kind === 'geojson') {
    const r = await fetch(url, { signal })
    if (!r.ok) throw new LayerLoadError('network', 'GeoJSON 加载失败')
    return (await r.json().catch(() => null)) as unknown
  }
  if (kind === 'feature') return fetchFeatureGeoJSON(url, DEFAULT_BUDGET_POLICY.maxFeatures, signal)
  throw new LayerLoadError('unsupported', `不支持的数据加载：${kind}`)
}

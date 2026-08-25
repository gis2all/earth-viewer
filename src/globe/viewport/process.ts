import { parseFeatureCollection } from './featureQuery'
import { applyVertexBudget } from './budget'
import { consumeFeatureBudget } from '../loadSafety'

export interface ViewportProcessInput {
  geojson: unknown
  maxVertices?: number
  maxFeatures?: number
}

export interface ViewportProcessResult {
  features: Record<string, unknown>[]
  capped: boolean
  vertices: number
}

/**
 * 视口数据统一处理管线（在 Web Worker 中运行，主线程也直接调用做单测）：
 * 解析 → 顶点抽稀/预算 → 要素数预算。返回可直接渲染（Primitive/GeoJSON）的 features。
 */
export function processViewportData(input: ViewportProcessInput): ViewportProcessResult {
  const maxVertices = input.maxVertices ?? 200_000
  const maxFeatures = input.maxFeatures ?? 3000
  const fc = parseFeatureCollection(input.geojson)
  // ① 顶点预算 + 抽稀（防复杂几何）
  const vb = applyVertexBudget({ type: 'FeatureCollection', features: fc.features }, maxVertices)
  // ② 要素数预算（防对象爆炸）
  const fb = consumeFeatureBudget(maxFeatures, vb.data, maxFeatures)
  const features = (fb?.data as { features?: Record<string, unknown>[] } | null)?.features ?? []
  // 要素超限（fb.capped）也算 bounded，便于调用方提示降级
  return { features, capped: vb.capped || (fb ? fb.capped : true), vertices: vb.vertices }
}

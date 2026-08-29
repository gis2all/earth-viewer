/** 视口数据统一加工管线：GeoJSON 纯解析 → 顶点预算/抽稀 → 要素数预算（无网络、无渲染依赖）。 */
import { consumeFeatureBudget } from '../../domain/loadSafety'
import { simplifyFeatureCollection } from '../../domain/geometry/geometry'

/** 把 Geojson/ArcGIS 响应统一成 { type, features }。 */
export function parseFeatureCollection(json: unknown): { type: 'FeatureCollection'; features: Record<string, unknown>[] } {
  const j = json as { type?: string; features?: Record<string, unknown>[]; geometry?: unknown; properties?: unknown } | null
  if (!j || typeof j !== 'object') return { type: 'FeatureCollection', features: [] }
  if (Array.isArray(j.features)) return { type: 'FeatureCollection', features: j.features }
  // 单个 Feature（GeoJSON 文件可能直接给一个 Feature）
  if (j.type === 'Feature' || j.geometry || j.properties) return { type: 'FeatureCollection', features: [j as Record<string, unknown>] }
  return { type: 'FeatureCollection', features: [] }
}

/** 统计单个 feature 的几何顶点数（坐标对数）。 */
export function countVertices(feature: Record<string, unknown>): number {
  const g = feature?.geometry as { coordinates?: unknown } | undefined
  const c = g?.coordinates
  if (!Array.isArray(c)) return 0
  if (typeof c[0] === 'number') return 1
  let n = 0
  const walk = (arr: unknown[]): void => {
    for (const item of arr) {
      if (Array.isArray(item)) {
        if (typeof item[0] === 'number') n++
        else walk(item as unknown[])
      }
    }
  }
  walk(c)
  return n
}

/** 统计 FeatureCollection 的总顶点数（比"要素数"更能反映内存占用）。 */
export function countFeatureCollectionVertices(fc: { type: string; features: Record<string, unknown>[] } | unknown): number {
  const features = (fc as { features?: Record<string, unknown>[] } | null)?.features
  if (!Array.isArray(features)) return 0
  let n = 0
  for (const f of features) n += countVertices(f)
  return n
}

export interface BudgetResult<T> {
  data: T
  capped: boolean
  vertices: number
}

/**
 * 顶点预算：统计 FeatureCollection 总顶点数，超出 maxVertices 时逐级抽稀（tolerance 翻倍），
 * 仍超出则返回抽稀结果并标记 capped。这是"防单个大 polygon 内存爆炸"的关键。
 */
export function applyVertexBudget<T extends { type: string; features: Record<string, unknown>[] }>(
  fc: T,
  maxVertices: number,
  initialTolerance = 1e-5
): BudgetResult<T> {
  let vertices = countFeatureCollectionVertices(fc)
  if (vertices <= maxVertices) return { data: fc, capped: false, vertices }

  // ① 逐级抽稀（tolerance 翻倍），最多几轮
  let tolerance = initialTolerance
  let data = fc
  for (let i = 0; i < 6; i++) {
    data = simplifyFeatureCollection(data, tolerance) as T
    vertices = countFeatureCollectionVertices(data)
    if (vertices <= maxVertices) return { data, capped: true, vertices }
    tolerance *= 10
  }

  // ② 仍超预算：硬截断（只保留前面的 feature），保证顶点降下来（防单层大 polygon 内存爆炸）
  let acc = 0
  const keep: Record<string, unknown>[] = []
  for (const f of data.features) {
    const v = countVertices(f)
    if (acc + v > maxVertices) break
    keep.push(f)
    acc += v
  }
  return { data: { ...data, features: keep } as T, capped: true, vertices: acc }
}

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

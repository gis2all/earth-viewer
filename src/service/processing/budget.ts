import { countVertices, countFeatureCollectionVertices } from './featureParse'
import { simplifyFeatureCollection } from '../../domain/geometry/simplify'

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

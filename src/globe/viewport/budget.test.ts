import { describe, it, expect } from 'vitest'
import { applyVertexBudget } from './budget'

// 锯齿状折线：每个点都偏离首尾连线，Douglas-Peucker 在 tolerance 增大到 1 度时也基本不抽稀，
// 用来稳定触发「6 轮抽稀仍超预算 → 硬截断 feature」路径。
function zigzag(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? [0, i] : [1000, i])) as [number, number][]
}

describe('applyVertexBudget', () => {
  it('未超预算：原样返回且不 capped', () => {
    const fc = { type: 'FeatureCollection', features: [{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }] }
    const r = applyVertexBudget(fc, 10)
    expect(r.capped).toBe(false)
    expect(r.data).toBe(fc)
    expect(r.vertices).toBe(2)
  })

  it('超预算：抽稀后回到预算内并标记 capped', () => {
    const coords = Array.from({ length: 200 }, (_, i) => [i * 0.001, Math.sin(i)]) as [number, number][]
    const fc = { type: 'FeatureCollection', features: [{ geometry: { type: 'LineString', coordinates: coords } }] }
    const r = applyVertexBudget(fc, 10)
    expect(r.capped).toBe(true)
    expect(r.vertices).toBeLessThanOrEqual(10)
  })

  it('6 轮抽稀仍超预算：硬截断 feature 直至顶点回落', () => {
    const features = Array.from({ length: 30 }, () => ({ geometry: { type: 'LineString', coordinates: zigzag(50) } }))
    const fc = { type: 'FeatureCollection', features }
    const r = applyVertexBudget(fc, 100)
    expect(r.capped).toBe(true)
    expect(r.vertices).toBeLessThanOrEqual(100)
    // 硬截断后应丢弃一部分 feature（保留的少了）
    expect((r.data as { features: unknown[] }).features.length).toBeLessThan(features.length)
  })
})

import { describe, it, expect } from 'vitest'
import { createBudgetPolicy, DEFAULT_BUDGET_POLICY } from './policy'

// 默认值统一来自 domain/config.ts（W4.2）；loadSafety.test.ts 里另有对齐断言防漂移。
describe('BudgetPolicy', () => {
  it('默认值对齐 SAFETY', () => {
    expect(DEFAULT_BUDGET_POLICY).toEqual({
      maxFeatures: 3000,
      maxTotalFeatures: 5000,
      maxRenderFeatures: 1500,
      maxRenderVertices: 200_000,
      maxFileBytes: 8_000_000,
      kmlMaxBytes: 2_000_000,
      vectorTileMaxZoom: 16,
      imageryMaxLevel: 16,
    })
  })

  it('createBudgetPolicy 支持局部覆盖且不污染默认值', () => {
    const p = createBudgetPolicy({ maxFeatures: 100, vectorTileMaxZoom: 18 })
    expect(p.maxFeatures).toBe(100)
    expect(p.vectorTileMaxZoom).toBe(18)
    expect(p.maxRenderFeatures).toBe(DEFAULT_BUDGET_POLICY.maxRenderFeatures)
    expect(DEFAULT_BUDGET_POLICY.maxFeatures).toBe(3000)
  })

  it('无覆盖时返回默认对象', () => {
    expect(createBudgetPolicy()).toBe(DEFAULT_BUDGET_POLICY)
  })
})

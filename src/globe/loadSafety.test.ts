import { describe, it, expect, vi } from 'vitest'
import { consumeFeatureBudget, riskOfLayer, degradeReason, assertUrlWithinLimit } from './loadSafety'
import { SAFETY } from './loadSafety'
import { DEFAULT_BUDGET_POLICY } from '../domain/policy'

describe('SAFETY 与 domain BudgetPolicy 对齐（W1.4 防漂移）', () => {
  it('默认值一致', () => {
    expect({
      maxFeatures: SAFETY.MAX_FEATURES,
      maxTotalFeatures: SAFETY.MAX_TOTAL_FEATURES,
      maxRenderFeatures: SAFETY.MAX_RENDER_FEATURES,
      maxRenderVertices: SAFETY.MAX_RENDER_VERTICES,
      maxFileBytes: SAFETY.MAX_FILE_BYTES,
      kmlMaxBytes: SAFETY.KML_MAX_BYTES,
      vectorTileMaxZoom: SAFETY.VECTOR_TILE_MAX_ZOOM,
      sceneMaxLod: SAFETY.SCENE_MAX_LOD,
      imageryMaxLevel: SAFETY.IMAGERY_MAX_LEVEL,
    }).toEqual(DEFAULT_BUDGET_POLICY)
  })
})

describe('consumeFeatureBudget', () => {
  it('空 features 原样返回，不消耗预算', () => {
    const r = consumeFeatureBudget(5000, { type: 'FeatureCollection', features: [] }, 1500)
    expect(r).toEqual({ remaining: 5000, data: { type: 'FeatureCollection', features: [] }, capped: false })
  })

  it('remaining 0 且有待渲染要素 → 返回 null（省略该层）', () => {
    expect(consumeFeatureBudget(0, { features: Array(10) }, 1500)).toBeNull()
  })

  it('单层超过 maxRender → 截断并标记 capped', () => {
    const gj = { type: 'FeatureCollection', features: Array(2000) }
    const r = consumeFeatureBudget(5000, gj, 1500)
    expect(r?.capped).toBe(true)
    expect((r?.data as { features?: unknown[] }).features?.length).toBe(1500)
    expect(r?.remaining).toBe(5000 - 1500)
  })

  it('未超上限 → 原样返回，正常扣预算', () => {
    const gj = { features: Array(100) }
    const r = consumeFeatureBudget(5000, gj, 1500)
    expect(r?.capped).toBe(false)
    expect((r?.data as { features?: unknown[] }).features?.length).toBe(100)
    expect(r?.remaining).toBe(5000 - 100)
  })
})


describe('loadSafety 图层风险', () => {
  it('riskOfLayer 按类型分级', () => {
    expect(riskOfLayer({ layerType: 'FeatureLayer' })).toBe('heavy')
    expect(riskOfLayer({ layerType: 'VectorTileLayer' })).toBe('medium')
    expect(riskOfLayer({ layerType: 'WMSLayer' })).toBe('medium')
    expect(riskOfLayer({ layerType: 'UnknownKind' })).toBe('light')
    expect(riskOfLayer({ layerType: 'SceneLayer' })).toBe('heavy')
    expect(riskOfLayer({ layerType: '3DTiles' })).toBe('heavy')
  })

  it('degradeReason 对重层给出原因', () => {
    expect(degradeReason({ layerType: 'FeatureLayer' })).toBeDefined()
    expect(degradeReason({ layerType: 'WMSLayer' })).toBeUndefined()
  })

  it('degradeReason 不再降级矢量瓦片（MapLibre 直接样式渲染）', () => {
    expect(degradeReason({ layerType: 'VectorTileLayer', styleUrl: 'https://cdn.arcgis.com/sharing/rest/content/items/abc/resources/styles/root.json' })).toBeUndefined()
  })
})


describe('assertUrlWithinLimit', () => {
  it('非 jsdom 下按 content-length 判断（正常通过 / 超限抛错）', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/126' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => '2000' } })))
    await expect(assertUrlWithinLimit('https://x/file.json', 1000)).rejects.toThrow()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => '100' } })))
    await expect(assertUrlWithinLimit('https://x/file.json', 1000)).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})


describe('assertUrlWithinLimit (more)', () => {
  it('fetch 非 ok 直接返回', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/126' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    await expect(assertUrlWithinLimit('https://x/f.json', 1000)).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})

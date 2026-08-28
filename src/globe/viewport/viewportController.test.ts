import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createViewportController } from './viewportController'

vi.mock('./query', () => ({ queryViewportData: vi.fn() }))
vi.mock('../facade/primitive', () => ({
  buildLayerPrimitive: vi.fn((_scene, model) => ({ collection: { model }, dispose: vi.fn() })),
  hasPrimitiveRendering: vi.fn(() => true),
}))
import { queryViewportData } from './query'
import { buildLayerPrimitive } from '../facade/primitive'

describe('createViewportController', () => {
  beforeEach(() => {
    vi.mocked(queryViewportData).mockClear()
    vi.mocked(buildLayerPrimitive).mockClear()
  })

  it('首次 update 查询并加入 primitives', async () => {
    vi.mocked(queryViewportData).mockResolvedValueOnce({ features: [{ geometry: { type: 'Point', coordinates: [1, 2] } }] as never, capped: false, vertices: 1 })
    const prims = { add: vi.fn() }
    const ctl = createViewportController({}, prims, { serviceUrl: 'https://x/FeatureServer' })
    await ctl.update({ west: 1, south: 2, east: 3, north: 4 })
    expect(queryViewportData).toHaveBeenCalledTimes(1)
    expect(buildLayerPrimitive).toHaveBeenCalledTimes(1)
    expect(prims.add).toHaveBeenCalledTimes(1)
  })

  it('同视口命中 LRU 不重复查询；dispose 释放当前', async () => {
    vi.mocked(queryViewportData).mockResolvedValueOnce({ features: [] as never, capped: false, vertices: 0 })
    const prims = { add: vi.fn() }
    const ctl = createViewportController({}, prims, { serviceUrl: 'https://x/FeatureServer' })
    await ctl.update({ west: 1, south: 2, east: 3, north: 4 })
    await ctl.update({ west: 1.1, south: 2.1, east: 3.1, north: 4.1 }) // 相同量化 key
    expect(queryViewportData).toHaveBeenCalledTimes(1)
    expect(prims.add).toHaveBeenCalledTimes(1)
    ctl.dispose()
  })
})

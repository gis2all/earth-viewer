import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createViewportController, createViewportDriver } from './viewportController'

vi.mock('./viewportQuery', () => ({ queryViewportData: vi.fn() }))
vi.mock('../../infra/primitive', () => ({
  buildLayerPrimitive: vi.fn((_scene, model) => ({ collection: { model }, dispose: vi.fn() })),
  hasPrimitiveRendering: vi.fn(() => true),
}))
import { queryViewportData } from './viewportQuery'
import { buildLayerPrimitive, hasPrimitiveRendering } from '../../infra/primitive'

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

  it('hasPrimitiveRendering=false 时 update 直接返回，不查询', async () => {
    vi.mocked(hasPrimitiveRendering).mockReturnValueOnce(false)
    const prims = { add: vi.fn() }
    const ctl = createViewportController({}, prims, { serviceUrl: 'https://x/FeatureServer' })
    await ctl.update({ west: 1, south: 2, east: 3, north: 4 })
    expect(queryViewportData).not.toHaveBeenCalled()
    expect(prims.add).not.toHaveBeenCalled()
  })

  it('capped=true 时通知 onNote', async () => {
    const onNote = vi.fn()
    vi.mocked(queryViewportData).mockResolvedValueOnce({ features: [] as never, capped: true, vertices: 0 })
    const prims = { add: vi.fn() }
    const ctl = createViewportController({}, prims, { serviceUrl: 'https://x/FeatureServer', onNote })
    await ctl.update({ west: 1, south: 2, east: 3, north: 4 })
    expect(onNote).toHaveBeenCalledWith('数据量大，已按视口/顶点预算降级显示')
  })

  it('query 抛错时静默跳过，不加入 primitives', async () => {
    vi.mocked(queryViewportData).mockRejectedValueOnce(new Error('服务不可达'))
    const prims = { add: vi.fn() }
    const ctl = createViewportController({}, prims, { serviceUrl: 'https://x/FeatureServer' })
    await expect(ctl.update({ west: 1, south: 2, east: 3, north: 4 })).resolves.toBeUndefined()
    expect(prims.add).not.toHaveBeenCalled()
  })

  it('切换视口时释放上一个 primitive 集合', async () => {
    vi.mocked(queryViewportData).mockResolvedValue({ features: [] as never, capped: false, vertices: 0 })
    const prims = { add: vi.fn() }
    const ctl = createViewportController({}, prims, { serviceUrl: 'https://x/FeatureServer' })
    await ctl.update({ west: 1, south: 2, east: 3, north: 4 })
    const firstDispose = vi.mocked(buildLayerPrimitive).mock.results[0].value.dispose
    await ctl.update({ west: 50, south: 50, east: 60, north: 60 }) // 不同量化 key
    expect(queryViewportData).toHaveBeenCalledTimes(2)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(prims.add).toHaveBeenCalledTimes(2)
  })
})

describe('createViewportDriver', () => {
  beforeEach(() => {
    vi.mocked(queryViewportData).mockClear()
    vi.mocked(buildLayerPrimitive).mockClear()
  })

  it('立即按当前包络更新一次，并订阅 moveEnd；unsubscribe 幂等移除监听', () => {
    vi.mocked(queryViewportData).mockResolvedValueOnce({ features: [] as never, capped: false, vertices: 0 })
    let removed = 0
    const onMoveEnd = vi.fn((_cb: () => void) => () => {
      removed++
    })
    const surface = {
      scene: {},
      prims: { add: vi.fn() },
      onMoveEnd,
      viewEnvelope: vi.fn(() => ({ west: 1, south: 2, east: 3, north: 4 })),
      requestFrame: vi.fn(),
    }
    const handle = createViewportDriver(surface, { serviceUrl: 'https://x/FeatureServer' })
    expect(surface.viewEnvelope).toHaveBeenCalledTimes(1)
    expect(queryViewportData).toHaveBeenCalledTimes(1)
    expect(onMoveEnd).toHaveBeenCalledTimes(1)
    handle.unsubscribeMoveEnd()
    handle.unsubscribeMoveEnd()
    expect(removed).toBe(1)
    handle.controller.dispose()
  })

  it('viewEnvelope 为空时回退全局兜底包络', () => {
    vi.mocked(queryViewportData).mockResolvedValueOnce({ features: [] as never, capped: false, vertices: 0 })
    const surface = {
      scene: {},
      prims: { add: vi.fn() },
      onMoveEnd: vi.fn(() => () => {}),
      viewEnvelope: vi.fn(() => null),
      requestFrame: vi.fn(),
    }
    const handle = createViewportDriver(surface, { serviceUrl: 'https://x/FeatureServer' })
    expect(queryViewportData).toHaveBeenCalledWith(
      'https://x/FeatureServer',
      { west: -180, south: -90, east: 180, north: 90 },
      expect.anything()
    )
    handle.unsubscribeMoveEnd()
  })

  it('moveEnd 防抖 250ms 后按新视口再次更新（合并连续触发）', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(queryViewportData).mockResolvedValue({ features: [] as never, capped: false, vertices: 0 })
      let moveCb: (() => void) | undefined
      const onMoveEnd = vi.fn((cb: () => void) => {
        moveCb = cb
        return () => {}
      })
      const requestFrame = vi.fn()
      const viewEnvelope = vi.fn(() => ({ west: 1, south: 2, east: 3, north: 4 }))
      const surface = {
        scene: {},
        prims: { add: vi.fn() },
        onMoveEnd,
        viewEnvelope,
        requestFrame,
      }
      const handle = createViewportDriver(surface, { serviceUrl: 'https://x/FeatureServer' })
      await vi.advanceTimersByTimeAsync(0) // 初始更新完成
      expect(queryViewportData).toHaveBeenCalledTimes(1)

      viewEnvelope.mockReturnValue({ west: 50, south: 50, east: 60, north: 60 })
      moveCb?.()
      moveCb?.()
      await vi.advanceTimersByTimeAsync(100)
      expect(queryViewportData).toHaveBeenCalledTimes(1) // 未到 250ms
      await vi.advanceTimersByTimeAsync(160) // 连续触发只合并为一次
      expect(queryViewportData).toHaveBeenCalledTimes(2)
      expect(requestFrame).toHaveBeenCalledTimes(2)
      handle.unsubscribeMoveEnd()
    } finally {
      vi.useRealTimers()
    }
  })
})

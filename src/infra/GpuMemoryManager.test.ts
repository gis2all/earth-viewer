import { describe, it, expect, vi } from 'vitest'
import { GpuMemoryManager, defaultGpuBudgetBytes } from './GpuMemoryManager'
import {
  GPU_TIERS,
  estimateSceneCanvasBytes,
  estimateVectorProviderBytes,
  type GpuTierConfig,
} from '../globe/facade/gpuBudget'

/** 像素类资源：估算随档位缩放（贴合画布/缓存随档位变小的真实行为）。 */
const TIER_FACTOR: Record<string, number> = { high: 1, medium: 0.5, low: 0.25, critical: 0.1 }

function tierResource(highBytes: number) {
  return {
    estimateBytes: (tier: GpuTierConfig) => highBytes * TIER_FACTOR[tier.name],
  }
}

describe('GpuMemoryManager（B 档：完整动态预算管理器）', () => {
  it('默认档位为 high，预算取 deviceMemory 或 256MB 兜底', () => {
    const m = new GpuMemoryManager(256 * 1024 * 1024)
    expect(m.tierName()).toBe('high')
    expect(m.current()).toEqual(GPU_TIERS.high)
    expect(m.budgetBytes).toBe(256 * 1024 * 1024)
    expect(defaultGpuBudgetBytes()).toBe(256 * 1024 * 1024)
  })

  it('总估算超预算时逐级降档（high → medium → low → critical）', () => {
    const budget = 200 * 1024 * 1024
    const m = new GpuMemoryManager(budget)
    m.register('scene', tierResource(100 * 1024 * 1024))
    expect(m.tierName()).toBe('high')
    // high 超预算、medium 内 → medium
    m.register('vt:test', tierResource(300 * 1024 * 1024))
    expect(m.tierName()).toBe('medium')
    // medium 超预算、low 内 → low
    m.register('vt:heavy', tierResource(200 * 1024 * 1024))
    expect(m.tierName()).toBe('low')
    // low 也超预算 → 到底 critical
    m.register('vt:max', tierResource(400 * 1024 * 1024))
    expect(m.tierName()).toBe('critical')
    expect(m.estimatedBytes()).toBeGreaterThan(0)
  })

  it('档位只降不升：unregister 释放内存后不会立即升档（避免重建风暴）', () => {
    const m = new GpuMemoryManager(100 * 1024 * 1024)
    m.register('scene', tierResource(80 * 1024 * 1024))
    m.register('vt:test', tierResource(300 * 1024 * 1024))
    expect(m.tierName()).toBe('low')
    m.unregister('vt:test')
    expect(m.tierName()).toBe('low')
    // 全部释放仍保持在降档后的档位
    m.unregister('scene')
    expect(m.tierName()).toBe('low')
  })

  it('上下文丢失逐次封顶：1 次 → medium，2 次 → low，3 次及以上 → critical', () => {
    const m = new GpuMemoryManager(1024 * 1024 * 1024)
    m.register('scene', tierResource(1 * 1024 * 1024))
    expect(m.tierName()).toBe('high')
    m.reportContextLost()
    expect(m.tierName()).toBe('medium')
    expect(m.contextLostCount()).toBe(1)
    m.reportContextLost()
    expect(m.tierName()).toBe('low')
    m.reportContextLost()
    expect(m.tierName()).toBe('critical')
    m.reportContextLost()
    expect(m.tierName()).toBe('critical')
  })

  it('档位变化时通知订阅者（携带新旧档位），取消订阅后不再通知', () => {
    const m = new GpuMemoryManager(100 * 1024 * 1024)
    const cb = vi.fn()
    const unsubscribe = m.subscribe(cb)
    m.register('scene', tierResource(80 * 1024 * 1024))
    m.register('vt:test', tierResource(150 * 1024 * 1024))
    expect(cb).toHaveBeenCalledTimes(1)
    const [next, prev] = cb.mock.calls[0] as [GpuTierConfig, GpuTierConfig]
    expect(next.name).toBe('low')
    expect(prev.name).toBe('high')
    unsubscribe()
    m.register('vt:more', tierResource(999 * 1024 * 1024))
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('update 仅更新已注册资源并重新核算', () => {
    const m = new GpuMemoryManager(100 * 1024 * 1024)
    m.register('scene', tierResource(80 * 1024 * 1024))
    expect(m.tierName()).toBe('high')
    // 未注册 id 不生效
    m.update('nope', tierResource(999 * 1024 * 1024))
    expect(m.tierName()).toBe('high')
    // 已注册 id 生效并触发降档
    m.update('scene', tierResource(400 * 1024 * 1024))
    expect(m.tierName()).toBe('low')
  })
})

describe('gpuBudget 估算函数', () => {
  it('estimateVectorProviderBytes：高/中/低档像素内存依次递减', () => {
    const high = estimateVectorProviderBytes(GPU_TIERS.high)
    const medium = estimateVectorProviderBytes(GPU_TIERS.medium)
    const low = estimateVectorProviderBytes(GPU_TIERS.low)
    const critical = estimateVectorProviderBytes(GPU_TIERS.critical)
    expect(high).toBeGreaterThan(medium)
    expect(medium).toBeGreaterThan(low)
    expect(low).toBeGreaterThan(critical)
    // high: 3×1536²×8 + 12×9×512²×4
    expect(high).toBe(3 * 1536 ** 2 * 8 + 12 * 9 * 512 ** 2 * 4)
  })

  it('estimateSceneCanvasBytes：分辨率缩放后缓冲字节按比例缩减', () => {
    const full = estimateSceneCanvasBytes(1920, 1080, GPU_TIERS.high)
    const half = estimateSceneCanvasBytes(1920, 1080, GPU_TIERS.critical)
    expect(full).toBe(1920 * 1080 * 4 * 2)
    expect(half).toBe(1920 * 1080 * 4 * 2 * 0.5 ** 2)
  })
})

/**
 * GpuMemoryManager（B 档：完整动态预算管理器）。
 *
 * 职责：
 * - 资源核算：各 provider / 主场景渲染缓冲按当前档位估算内存并注册上报；
 * - 预算与降级阶梯：总估算超全局预算时逐级降档（high → medium → low → critical）；
 * - 全局并发闸门：所有矢量瓦片 provider 的池/缓存上限统一取自当前档位；
 * - 上下文丢失统一处理：任意 WebGL 上下文丢失上报后强制降档，订阅者重建失效 provider，
 *   避免 GPU 内存耗尽后白屏/崩溃。
 */
import {
  GPU_TIER_ORDER,
  GPU_TIERS,
  type GpuTierConfig,
  type GpuTierName,
} from './gpuTiers'

export interface GpuResource {
  /** 该资源在指定档位下的估算字节数 */
  estimateBytes(tier: GpuTierConfig): number
}

/** 默认预算约 256MB；低内存设备按 deviceMemory 收紧（4GB → 256MB，2GB → 128MB）。 */
export function defaultGpuBudgetBytes(): number {
  if (typeof navigator !== 'undefined') {
    const dm = (navigator as { deviceMemory?: number }).deviceMemory
    if (typeof dm === 'number' && dm > 0) {
      const mb = Math.max(128, Math.min(256, dm * 64))
      return mb * 1024 * 1024
    }
  }
  return 256 * 1024 * 1024
}

export class GpuMemoryManager {
  private readonly _resources = new Map<string, GpuResource>()
  private readonly _budgetBytes: number
  private readonly _listeners = new Set<(tier: GpuTierConfig, prev: GpuTierConfig) => void>()
  private _tier: GpuTierName = 'high'
  private _ctxLostCount = 0

  constructor(budgetBytes = defaultGpuBudgetBytes()) {
    this._budgetBytes = budgetBytes
  }

  get budgetBytes(): number {
    return this._budgetBytes
  }

  /** 注册资源并重新核算；返回核算后的档位。 */
  register(id: string, resource: GpuResource): GpuTierConfig {
    this._resources.set(id, resource)
    return this._recompute()
  }

  /** 更新资源估算器并重新核算。 */
  update(id: string, resource: GpuResource): GpuTierConfig {
    if (this._resources.has(id)) this._resources.set(id, resource)
    return this._recompute()
  }

  /** 注销资源并重新核算（内存释放后可能升档到预算内档位）。 */
  unregister(id: string): GpuTierConfig {
    this._resources.delete(id)
    // 释放一个矢量 provider：腾出 WebGL 上下文与内存。让档位可回弹，
    // 而不是永久停留在降档档位（否则移除图层后剩下的图层持续模糊）。
    this._ctxLostCount = Math.max(0, this._ctxLostCount - 1)
    return this._recompute('recover')
  }

  /**
   * 上报一次 WebGL 上下文丢失：每次丢失把允许的最高档位下调一档
   * （1 次 → 最高 medium，2 次 → 最高 low，3 次及以上 → critical），
   * 并在预算核算中优先选择受限档位。
   */
  reportContextLost(): GpuTierConfig {
    this._ctxLostCount += 1
    return this._recompute()
  }

  /**
   * 上报一次 WebGL 上下文恢复：抵消失去计数，并重新核算。
   * 与 reportContextLost 配对，避免“丢过一次就永久封顶”导致移除/恢复后仍停在降档档位。
   */
  reportContextRestored(): GpuTierConfig {
    this._ctxLostCount = Math.max(0, this._ctxLostCount - 1)
    return this._recompute('recover')
  }

  contextLostCount(): number {
    return this._ctxLostCount
  }

  current(): GpuTierConfig {
    return GPU_TIERS[this._tier]
  }

  tierName(): GpuTierName {
    return this._tier
  }

  /** 当前档位下所有注册资源的估算总内存（字节），诊断/监控用。 */
  estimatedBytes(): number {
    const tier = this.current()
    let total = 0
    for (const r of this._resources.values()) total += r.estimateBytes(tier)
    return total
  }

  /** 档位变化时通知；返回取消订阅函数。 */
  subscribe(cb: (tier: GpuTierConfig, prev: GpuTierConfig) => void): () => void {
    this._listeners.add(cb)
    return () => {
      this._listeners.delete(cb)
    }
  }

  private _sumBytes(tier: GpuTierConfig): number {
    let total = 0
    for (const r of this._resources.values()) total += r.estimateBytes(tier)
    return total
  }

  private _recompute(mode: 'settle' | 'recover' = 'settle'): GpuTierConfig {
    const order = GPU_TIER_ORDER
    const curIndex = order.indexOf(this._tier)
    // 上下文丢失后允许的最高档位（0 丢失 = high 即 index 0；1 次 → medium…；index 越大越省内存）
    const lossCapIndex = Math.min(order.length - 1, this._ctxLostCount)

    let nextIndex: number
    if (mode === 'recover') {
      // 恢复：找“当前资源能负担的最不保守档位”（最小 index），并受上下文丢失上限约束，
      // 且不超过已降档前的质量（recover 只升不降）。这使移除图层/上下文恢复后
      // resolutionScale 能回到 1，消除“剩余图层持续模糊”。
      let loose = order.length - 1
      for (let i = 0; i < order.length; i += 1) {
        if (this._sumBytes(GPU_TIERS[order[i]]) <= this._budgetBytes) {
          loose = i
          break
        }
      }
      nextIndex = Math.min(curIndex, Math.max(loose, lossCapIndex))
    } else {
      // 沉降：从当前档位与上下文丢失上限中更严格者起步，只允许更保守（只降不升）。
      // 这避免 provider 重建期间 register/unregister 反复触发升降档造成重建风暴。
      nextIndex = Math.max(curIndex, lossCapIndex)
      while (nextIndex < order.length - 1) {
        if (this._sumBytes(GPU_TIERS[order[nextIndex]]) <= this._budgetBytes) break
        nextIndex += 1
      }
    }

    const prev = this.current()
    const nextName = order[nextIndex]
    if (nextName !== this._tier) {
      this._tier = nextName
      const next = GPU_TIERS[nextName]
      for (const cb of this._listeners) cb(next, prev)
      return next
    }
    return prev
  }
}

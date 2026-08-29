import type { FeatureQueryOptions } from './featureQuery'
import type { ViewEnvelope } from '../../domain/geometry/envelope'
import { queryViewportData } from './viewportQuery'
import { featuresToGeometryModel } from '../../domain/geometry/geometryModel'
import { buildLayerPrimitive, hasPrimitiveRendering } from '../../infra/primitive'
import { createLru, viewportCacheKey } from '../../domain/geometry/lru'
import { DEFAULT_APP_CONFIG } from '../../domain/config'

export interface ViewportControllerOptions extends FeatureQueryOptions {
  serviceUrl?: string
  cacheCap?: number
  onNote?: (msg: string) => void
}

export interface ViewportController {
  update(env: ViewEnvelope): Promise<void>
  dispose(): void
}

/**
 * 视口控制器（P1 完整形态）：按视口查询 → 抽稀/预算 → Primitive，并 LRU 缓存视口块。
 * 相机 moveEnd 时由调用方调用 update；重复/邻近视口命中缓存，内存只随当前视口 + 缓存容量增长。
 */
export function createViewportController(
  scene: unknown,
  prims: { add(x: unknown): void },
  opts: ViewportControllerOptions
): ViewportController {
  const cache = createLru<string, { collection: unknown; dispose: () => void }>(opts.cacheCap ?? 3)
  let current: { collection: unknown; dispose: () => void } | null = null

  async function update(env: ViewEnvelope): Promise<void> {
    if (!hasPrimitiveRendering()) return
    try {
      const key = viewportCacheKey(env)
      let entry = cache.get(key)
      if (!entry) {
        const res = await queryViewportData(opts.serviceUrl as string, env, { maxFeatures: opts.maxFeatures ?? 3000 })
        if (res.capped) opts.onNote?.('数据量大，已按视口/顶点预算降级显示')
        entry = buildLayerPrimitive(scene as never, featuresToGeometryModel(res.features))
        cache.set(key, entry)
        prims.add(entry.collection)
      }
      if (current && current !== entry) current.dispose()
      current = entry
    } catch {
      // 服务不可达/无数据：静默跳过该视口更新
    }
  }

  return {
    update,
    dispose: () => current?.dispose(),
  }
}

/**
 * 视口驱动表面（CesiumFacade 实现；结构类型，双方互不 import）。
 * - scene/prims：Primitive 构建与挂载容器；
 * - onMoveEnd：订阅相机 moveEnd，返回取消函数；
 * - viewEnvelope：当前视口包络（无相机时为 null，驱动回退全局）；
 * - requestFrame：requestRenderMode 下按需渲染一帧。
 */
export interface ViewportSurface {
  scene: unknown
  prims: { add(x: unknown): void }
  onMoveEnd(cb: () => void): () => void
  viewEnvelope(): ViewEnvelope | null
  requestFrame(): void
}

/** 视口驱动句柄（与 domain/renderContract.ViewportHandleLike 结构兼容，供 LayerController 释放）。 */
export interface ViewportDriverHandle {
  controller: ViewportController
  /** 移除相机 moveEnd 监听；幂等。 */
  unsubscribeMoveEnd(): void
}

/**
 * 视口驱动编排：创建控制器 + 立即更新一次 + moveEnd 防抖订阅。
 * 该编排原在 CesiumFacade（infra），上移到此（globe），切断 infra→globe 依赖。
 */
export function createViewportDriver(
  surface: ViewportSurface,
  opts: ViewportControllerOptions
): ViewportDriverHandle {
  const ctl = createViewportController(surface.scene, surface.prims, opts)
  let disposed = false
  const updateViewport = () =>
    ctl
      .update(surface.viewEnvelope() ?? DEFAULT_APP_CONFIG.viewportFallback)
      .finally(() => surface.requestFrame())
  const handler = debounce(() => void updateViewport(), 250)
  const offMoveEnd = surface.onMoveEnd(handler)
  void updateViewport()
  return {
    controller: ctl,
    unsubscribeMoveEnd: () => {
      if (disposed) return
      disposed = true
      offMoveEnd()
    },
  }
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

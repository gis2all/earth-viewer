import type { ViewEnvelope, FeatureQueryOptions } from './featureQuery'
import { queryViewportData } from './query'
import { featuresToGeometryModel } from './geometryModel'
import { buildLayerPrimitive, hasPrimitiveRendering } from './primitive'
import { createLru, viewportCacheKey } from './lru'

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

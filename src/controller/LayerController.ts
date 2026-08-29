/**
 * LayerController（W3.1）：图层生命周期唯一状态机 + 领域事件。
 * - 状态：pending → preflight → loading → ready / error / cancelled（W1.3 定义）；
 * - 事件：stateChange / ready / error / removed，供 Presentation 订阅刷新；
 * - 持有 LayerRuntime 表（替代 GlobeViewer 的 layerMapRef），删除时统一 abort + 释放；
 * - 串行渲染队列：同一时刻只渲染一个 webmap，避免重图层抢主线程。
 * 不 import Cesium / store：渲染由 deps.render 委托，错误/提示由 deps 桥接。
 */
import { createEmptyRuntime, type LayerRuntime } from '../domain/runtime'
import {
  assertTransition,
  isTerminal,
  type LayerState,
} from '../domain/stateMachine'
import type { LayerRenderJob, ViewportHandleLike } from '../domain/render'
import { LayerScheduler } from '../service/scheduler'

/** 控制器视角的图层条目（与 store.AddedLayer 结构兼容）。 */
export interface LayerItemLike {
  id: string
  title: string
  webmap?: Record<string, unknown>
  kind: string
}

export type LayerControllerEvent =
  | { type: 'stateChange'; id: string; state: LayerState }
  | { type: 'ready'; id: string }
  | { type: 'error'; id: string; message: string }
  | { type: 'removed'; id: string }

export interface LayerControllerDeps {
  /** 串行渲染一个 webmap 的全部内层（由 globe/renderWebmap + CesiumFacade 实现）。 */
  render(job: LayerRenderJob): Promise<void>
  /** 渲染器外部兜底错误（如非法 webmap 结构）写入 store。 */
  setError(id: string, message: string): void
  clearError(id: string): void
  /** 图层加载提示（如"数据量大，已降级"），由 Presentation 层展示。 */
  setNote(msg: string): void
  /** 区划/参考层可见性（来自效果开关）。 */
  getReferenceVisible(): boolean
  /** 视口优先级：数值越大越先渲染（排队中的 webmap 实时取值；缺省 0 = 添加顺序）。 */
  priorityFor?(item: LayerItemLike): number
  /** 释放 runtime 上的 Cesium 资源（facade.removeRuntime）。 */
  removeRuntime(runtime: LayerRuntime): void
}

interface Entry {
  item: LayerItemLike
  state: LayerState
  runtime: LayerRuntime
  abort: AbortController
  flew: boolean
  viewport?: ViewportHandleLike
}

export class LayerController {
  private entries = new Map<string, Entry>()
  private errors = new Map<string, string>()
  private listeners = new Set<(e: LayerControllerEvent) => void>()
  private scheduler = new LayerScheduler(1)
  private pendingJobs = new Map<string, Promise<unknown>>()
  private disposed = false

  constructor(private deps: LayerControllerDeps) {}

  subscribe(cb: (e: LayerControllerEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 只读快照：状态 + 错误信息（无则 undefined）。 */
  snapshot(id: string): { state: LayerState; error?: string } | undefined {
    const e = this.entries.get(id)
    if (!e) return undefined
    return { state: e.state, error: this.errors.get(id) }
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** 差分同步：先删已移除，再排队新增（与 GlobeViewer 原 effect 顺序一致）。 */
  setItems(items: LayerItemLike[]): void {
    if (this.disposed) return
    const ids = new Set(items.map((i) => i.id))
    for (const id of [...this.entries.keys()]) {
      if (!ids.has(id)) this.remove(id)
    }
    for (const item of items) {
      if (this.entries.has(item.id)) continue
      this.enqueue(item)
    }
  }

  dispose(): void {
    this.disposed = true
    this.scheduler.dispose()
    this.pendingJobs.clear()
    for (const id of [...this.entries.keys()]) this.remove(id)
    this.listeners.clear()
  }

  private emit(e: LayerControllerEvent): void {
    for (const cb of this.listeners) cb(e)
  }

  private enqueue(item: LayerItemLike): void {
    if (!item.webmap) return
    const entry: Entry = {
      item,
      state: 'pending',
      runtime: createEmptyRuntime(),
      abort: new AbortController(),
      flew: false,
    }
    this.entries.set(item.id, entry)
    this.emit({ type: 'stateChange', id: item.id, state: 'pending' })
    const promise = this.scheduler
      .submit({
        id: item.id,
        priority: () => this.deps.priorityFor?.(item) ?? 0,
        run: () => this.run(entry),
      })
      .catch((e: unknown) => {
        console.error('[layer] webmap 渲染失败', item.id, e)
      })
    this.pendingJobs.set(item.id, promise)
  }

  private async run(entry: Entry): Promise<void> {
    if (this.disposed || !this.entries.has(entry.item.id)) return
    this.transition(entry, 'preflight')
    this.transition(entry, 'loading')
    const job: LayerRenderJob = {
      id: entry.item.id,
      title: entry.item.title,
      webmap: entry.item.webmap as Record<string, unknown>,
      runtime: entry.runtime,
      signal: entry.abort.signal,
      keepAlive: () => !this.disposed && this.entries.has(entry.item.id),
      markFlew: () => {
        entry.flew = true
      },
      isReferenceVisible: () => this.deps.getReferenceVisible(),
      hasFlew: () => entry.flew,
      onNote: (msg) => this.deps.setNote(msg),
      onError: (msg) => {
        if (!this.entries.has(entry.item.id)) return
        this.errors.set(entry.item.id, msg)
        this.deps.setError(entry.item.id, msg)
      },
      onClearError: () => {
        if (!this.entries.has(entry.item.id)) return
        this.errors.delete(entry.item.id)
        this.deps.clearError(entry.item.id)
      },
      attachViewport: (h) => {
        entry.viewport = h
      },
    }
    try {
      await this.deps.render(job)
      if (!this.entries.has(entry.item.id)) return
      this.transition(entry, 'ready')
      this.emit({ type: 'ready', id: entry.item.id })
    } catch (e) {
      if (!this.entries.has(entry.item.id)) return
      console.error('[layer] webmap 渲染失败', entry.item.id, e)
      const message = '图层加载失败：' + (entry.item.title || entry.item.id)
      this.errors.set(entry.item.id, message)
      this.deps.setError(entry.item.id, message)
      this.transition(entry, 'error')
      this.emit({ type: 'error', id: entry.item.id, message })
    }
  }

  private remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.pendingJobs.delete(id)
    this.scheduler.cancel(id)
    entry.abort.abort()
    if (!isTerminal(entry.state)) this.transition(entry, 'cancelled')
    // 清理错误状态：异步任务可能在 abort 后仍调用 onError（已由 entries.has 守卫拦截），
    // 这里兜底删除残留，避免 errors map 泄漏与 store 中孤儿错误
    this.errors.delete(id)
    this.deps.clearError(id)
    entry.viewport?.unsubscribeMoveEnd()
    entry.viewport?.controller.dispose()
    this.deps.removeRuntime(entry.runtime)
    entry.runtime.dispose()
    this.emit({ type: 'removed', id })
  }

  private transition(entry: Entry, to: LayerState): void {
    assertTransition(entry.state, to)
    entry.state = to
    this.emit({ type: 'stateChange', id: entry.item.id, state: to })
  }
}

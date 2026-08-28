import { describe, it, expect, vi } from 'vitest'
import {
  LayerController,
  type LayerControllerDeps,
  type LayerItemLike,
} from './LayerController'
import type { LayerRenderJob, ViewportHandleLike } from '../domain/render'

function makeItem(id: string, overrides: Partial<LayerItemLike> = {}): LayerItemLike {
  return { id, title: `图层-${id}`, kind: 'webmap', webmap: { id }, ...overrides }
}

function deferred() {
  let resolve!: () => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(overrides: Partial<LayerControllerDeps> = {}) {
  const render = vi.fn()
  const setError = vi.fn()
  const clearError = vi.fn()
  const setNote = vi.fn()
  const getReferenceVisible = vi.fn(() => false)
  const removeRuntime = vi.fn()
  const deps: LayerControllerDeps = {
    render,
    setError,
    clearError,
    setNote,
    getReferenceVisible,
    removeRuntime,
    ...overrides,
  }
  const ctrl = new LayerController(deps)
  return { ctrl, render, setError, clearError, setNote, getReferenceVisible, removeRuntime }
}

describe('LayerController：状态流转与事件', () => {
  it('pending → preflight → loading → ready，并发布 ready 事件', async () => {
    const { ctrl, render } = setup()
    const d = deferred()
    render.mockReturnValue(d.promise)
    const states: string[] = []
    const events: string[] = []
    ctrl.subscribe((e) => {
      events.push(e.type)
      if (e.type === 'stateChange') states.push(e.state)
    })

    ctrl.setItems([makeItem('a')])
    await flush()
    expect(states).toEqual(['pending', 'preflight', 'loading'])

    d.resolve()
    await flush()
    expect(states).toEqual(['pending', 'preflight', 'loading', 'ready'])
    expect(events).toContain('ready')
    expect(ctrl.snapshot('a')?.state).toBe('ready')
  })

  it('渲染失败 → error 状态、兜底错误写入 store、发布 error 事件', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctrl, render, setError } = setup()
    render.mockRejectedValue(new Error('boom'))
    const events: string[] = []
    let message = ''
    ctrl.subscribe((e) => {
      events.push(e.type)
      if (e.type === 'error') message = e.message
    })

    ctrl.setItems([makeItem('a', { title: '区划' })])
    await flush()

    expect(setError).toHaveBeenCalledWith('a', '图层加载失败：区划')
    expect(ctrl.snapshot('a')?.state).toBe('error')
    expect(ctrl.snapshot('a')?.error).toBe('图层加载失败：区划')
    expect(message).toBe('图层加载失败：区划')
    expect(events).toContain('error')
    vi.restoreAllMocks()
  })

  it('isReferenceVisible 透传效果开关状态', async () => {
    const { ctrl, render, getReferenceVisible } = setup()
    const d = deferred()
    render.mockReturnValue(d.promise)
    getReferenceVisible.mockReturnValue(true)
    ctrl.setItems([makeItem('a')])
    await flush()
    const job = render.mock.calls[0][0] as LayerRenderJob
    expect(job.isReferenceVisible()).toBe(true)
    d.resolve()
    await flush()
  })
})

describe('LayerController：差分同步与竞态', () => {
  it('重复添加同一 id 只渲染一次', async () => {
    const { ctrl, render } = setup()
    render.mockResolvedValue(undefined)
    ctrl.setItems([makeItem('a')])
    ctrl.setItems([makeItem('a')])
    await flush()
    expect(render).toHaveBeenCalledTimes(1)
    expect(ctrl.snapshot('a')?.state).toBe('ready')
  })

  it('移除 → abort + viewport 清理 + runtime 释放，异步回调被丢弃', async () => {
    const { ctrl, render, removeRuntime } = setup()
    const d = deferred()
    render.mockReturnValue(d.promise)
    const events: string[] = []
    ctrl.subscribe((e) => events.push(e.type))

    ctrl.setItems([makeItem('a')])
    await flush()
    const job = render.mock.calls[0][0] as LayerRenderJob
    const handle: ViewportHandleLike = {
      unsubscribeMoveEnd: vi.fn(),
      controller: { dispose: vi.fn() },
    }
    job.attachViewport?.(handle)

    expect(job.keepAlive()).toBe(true)
    expect(job.signal.aborted).toBe(false)

    ctrl.setItems([])
    expect(job.signal.aborted).toBe(true)
    expect(job.keepAlive()).toBe(false)
    expect(handle.unsubscribeMoveEnd).toHaveBeenCalled()
    expect(handle.controller.dispose).toHaveBeenCalled()
    expect(removeRuntime).toHaveBeenCalledTimes(1)
    expect(events).toContain('removed')
    expect(ctrl.has('a')).toBe(false)
    expect(ctrl.snapshot('a')).toBeUndefined()

    d.resolve()
    await flush()
    // 渲染完成但图层已删除：不产生 ready 状态
    expect(ctrl.has('a')).toBe(false)
  })

  it('队列中尚未开始的条目被移除后不再渲染', async () => {
    const { ctrl, render } = setup()
    const d1 = deferred()
    render.mockReturnValueOnce(d1.promise)
    ctrl.setItems([makeItem('a'), makeItem('b')])
    await flush()
    expect(render).toHaveBeenCalledTimes(1)

    ctrl.setItems([makeItem('a')])
    d1.resolve()
    await flush()
    expect(render).toHaveBeenCalledTimes(1)
    expect(ctrl.snapshot('b')).toBeUndefined()
  })

  it('无 webmap 的条目跳过渲染', async () => {
    const { ctrl, render } = setup()
    ctrl.setItems([{ id: 'x', title: 'x', kind: 'fallback' }])
    await flush()
    expect(render).not.toHaveBeenCalled()
    expect(ctrl.has('x')).toBe(false)
  })

  it('dispose 清空全部条目并停止后续生效', async () => {
    const { ctrl, render, removeRuntime } = setup()
    render.mockReturnValue(deferred().promise)
    ctrl.setItems([makeItem('a'), makeItem('b')])
    await flush()
    expect(render).toHaveBeenCalledTimes(1)

    ctrl.dispose()
    expect(ctrl.has('a')).toBe(false)
    expect(ctrl.has('b')).toBe(false)
    expect(removeRuntime).toHaveBeenCalledTimes(2)

    ctrl.setItems([makeItem('c')])
    await flush()
    expect(ctrl.has('c')).toBe(false)
    expect(render).toHaveBeenCalledTimes(1)
  })
})

describe('LayerController：串行渲染队列', () => {
  it('同一时刻只渲染一个，按添加顺序执行', async () => {
    const { ctrl, render } = setup()
    const d1 = deferred()
    const d2 = deferred()
    render.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)

    ctrl.setItems([makeItem('a'), makeItem('b')])
    await flush()
    expect(render).toHaveBeenCalledTimes(1)
    expect((render.mock.calls[0][0] as LayerRenderJob).id).toBe('a')

    d1.resolve()
    await flush()
    expect(render).toHaveBeenCalledTimes(2)
    expect((render.mock.calls[1][0] as LayerRenderJob).id).toBe('b')

    d2.resolve()
    await flush()
    expect(ctrl.snapshot('a')?.state).toBe('ready')
    expect(ctrl.snapshot('b')?.state).toBe('ready')
  })
})

describe('LayerController：job 回调与 deps 桥接', () => {
  it('onNote / onError / onClearError 分别桥接 setNote / setError / clearError', async () => {
    const { ctrl, render, setNote, setError, clearError } = setup()
    const d = deferred()
    render.mockReturnValue(d.promise)
    ctrl.setItems([makeItem('a')])
    await flush()
    const job = render.mock.calls[0][0] as LayerRenderJob

    job.onNote('数据量大，已降级')
    expect(setNote).toHaveBeenCalledWith('数据量大，已降级')

    job.onError('矢量瓦片渲染失败：x')
    expect(setError).toHaveBeenCalledWith('a', '矢量瓦片渲染失败：x')
    expect(ctrl.snapshot('a')?.error).toBe('矢量瓦片渲染失败：x')

    job.onClearError()
    expect(clearError).toHaveBeenCalledWith('a')
    expect(ctrl.snapshot('a')?.error).toBeUndefined()

    d.resolve()
    await flush()
  })

  it('hasFlew / markFlew：初始相机只处理一次', async () => {
    const { ctrl, render } = setup()
    const d = deferred()
    render.mockReturnValue(d.promise)
    ctrl.setItems([makeItem('a')])
    await flush()
    const job = render.mock.calls[0][0] as LayerRenderJob
    expect(job.hasFlew()).toBe(false)
    job.markFlew()
    expect(job.hasFlew()).toBe(true)
    d.resolve()
    await flush()
  })
})

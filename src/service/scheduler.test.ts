import { describe, it, expect, vi } from 'vitest'
import { LayerScheduler, type ScheduledJob } from './scheduler'

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function deferred() {
  let resolve!: () => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeJob(id: string, run: () => Promise<unknown> = async () => undefined, priority = 0): ScheduledJob {
  return { id, priority: () => priority, run }
}

describe('LayerScheduler：串行与并发上限', () => {
  it('默认并发 1：同一时刻只运行一个任务，按入队顺序执行', async () => {
    const s = new LayerScheduler(1)
    const order: string[] = []
    const d1 = deferred()
    const d2 = deferred()
    const p1 = s.submit(makeJob('a', async () => { order.push('a-start'); await d1.promise; order.push('a-end') }))
    const p2 = s.submit(makeJob('b', async () => { order.push('b-start'); await d2.promise; order.push('b-end') }))
    await flush()
    expect(order).toEqual(['a-start'])
    expect(s.activeCount).toBe(1)
    expect(s.pendingCount).toBe(1)
    d1.resolve()
    await p1
    await flush()
    expect(order).toEqual(['a-start', 'a-end', 'b-start'])
    d2.resolve()
    await p2
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('并发上限 2：两个并行运行，第三个等待', async () => {
    const s = new LayerScheduler(2)
    const running = new Set<string>()
    let peak = 0
    const d1 = deferred()
    const d2 = deferred()
    const d3 = deferred()
    const mk = (id: string, d: { promise: Promise<void>; resolve: () => void }) =>
      s.submit(makeJob(id, async () => {
        running.add(id)
        peak = Math.max(peak, running.size)
        await d.promise
        running.delete(id)
      }))
    const p1 = mk('a', d1)
    const p2 = mk('b', d2)
    const p3 = mk('c', d3)
    await flush()
    expect(running.size).toBe(2)
    expect(s.pendingCount).toBe(1)
    d1.resolve()
    await p1
    await flush()
    expect(running.has('c')).toBe(true)
    d2.resolve(); d3.resolve()
    await Promise.all([p2, p3])
    expect(peak).toBe(2)
  })
})

describe('LayerScheduler：优先级与取消', () => {
  it('后入队的高优先级任务插队先执行', async () => {
    const s = new LayerScheduler(1)
    const order: string[] = []
    const d1 = deferred()
    const d2 = deferred()
    const p1 = s.submit(makeJob('low', async () => { order.push('low'); await d1.promise }, 0))
    s.submit(makeJob('high', async () => { order.push('high'); await d2.promise }, 10))
    await flush()
    expect(order).toEqual(['low'])
    d1.resolve()
    await p1
    await flush()
    expect(order).toEqual(['low', 'high'])
    d2.resolve()
  })

  it('同优先级保持入队顺序（stable）', async () => {
    const s = new LayerScheduler(1)
    const order: string[] = []
    const d1 = deferred()
    const d2 = deferred()
    const p1 = s.submit(makeJob('a', async () => { order.push('a'); await d1.promise }, 5))
    s.submit(makeJob('b', async () => { order.push('b'); await d2.promise }, 5))
    await flush()
    d1.resolve()
    await p1
    await flush()
    expect(order).toEqual(['a', 'b'])
    d2.resolve()
  })

  it('cancel 移除排队任务；正在运行的任务不受影响', async () => {
    const s = new LayerScheduler(1)
    const d1 = deferred()
    const runA = vi.fn(async () => { await d1.promise })
    const runB = vi.fn(async () => undefined)
    const p1 = s.submit(makeJob('a', runA))
    const p2 = s.submit(makeJob('b', runB))
    await flush()
    expect(runA).toHaveBeenCalledTimes(1)
    s.cancel('b')
    expect(s.pendingCount).toBe(0)
    await p2
    expect(runB).not.toHaveBeenCalled()
    d1.resolve()
    await p1
    expect(runA).toHaveBeenCalledTimes(1)
  })

  it('dispose 清空排队任务并停止接收新任务', async () => {
    const s = new LayerScheduler(1)
    const d1 = deferred()
    const runA = vi.fn(async () => { await d1.promise })
    const p1 = s.submit(makeJob('a', runA))
    const p2 = s.submit(makeJob('b', async () => undefined))
    await flush()
    s.dispose()
    expect(s.pendingCount).toBe(0)
    await p2
    const p3 = s.submit(makeJob('c', async () => undefined))
    await expect(p3).resolves.toBeUndefined()
    d1.resolve()
    await p1
  })

  it('任务抛错原样 reject 并继续执行队列', async () => {
    const s = new LayerScheduler(1)
    const order: string[] = []
    const p1 = s.submit(makeJob('bad', async () => { order.push('bad'); throw new Error('boom') }))
    const p2 = s.submit(makeJob('ok', async () => { order.push('ok') }))
    await expect(p1).rejects.toThrow('boom')
    await p2
    expect(order).toEqual(['bad', 'ok'])
  })
})

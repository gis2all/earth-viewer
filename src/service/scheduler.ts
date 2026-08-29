/**
 * LayerScheduler（W4.1）：统一图层渲染调度器。
 * - 串行：同一时刻最多执行 concurrency 个任务（默认 1，与旧 renderQueue 行为一致）；
 * - 视口优先级：排队任务按 priority() 实时取值，大者先执行（同优先级保持入队顺序）；
 * - 取消：cancel(id) 移除尚未开始的任务；运行中任务由调用方自己的 AbortSignal 中断；
 * - 无渲染库依赖：run 的返回类型由调用方决定。
 */
export interface ScheduledJob<T = unknown> {
  readonly id: string
  /** 视口优先级：排队期间实时读取，越大越先执行。 */
  priority(): number
  run(): Promise<T>
}

interface QueueEntry<T> {
  job: ScheduledJob<T>
  resolve: (value: T | undefined) => void
  reject: (reason?: unknown) => void
}

export class LayerScheduler {
  private queue: QueueEntry<unknown>[] = []
  private active = 0
  private disposed = false

  constructor(private readonly concurrency = 1) {}

  get pendingCount(): number {
    return this.queue.length
  }

  get activeCount(): number {
    return this.active
  }

  /**
   * 提交任务：返回的 Promise 在任务执行完毕（或 dispose 取消排队）后落定。
   * 任务本身抛错会原样 reject，由调用方决定兜底。
   */
  submit<T>(job: ScheduledJob<T>): Promise<T | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    return new Promise<T | undefined>((resolve, reject) => {
      this.queue.push({ job, resolve, reject } as QueueEntry<unknown>)
      this.tick()
    })
  }

  /** 取消排队中的任务（不影响正在运行的任务）。 */
  cancel(id: string): void {
    const idx = this.queue.findIndex((e) => e.job.id === id)
    if (idx < 0) return
    const [entry] = this.queue.splice(idx, 1)
    entry.resolve(undefined)
  }

  /** 停止调度：清空排队任务；运行中的任务不受影响。 */
  dispose(): void {
    this.disposed = true
    const pending = this.queue.splice(0)
    for (const entry of pending) entry.resolve(undefined)
  }

  private tick(): void {
    if (this.disposed || this.active >= this.concurrency || this.queue.length === 0) return
    const idx = this.nextIndex()
    const [entry] = this.queue.splice(idx, 1)
    this.active++
    Promise.resolve()
      .then(() => entry.job.run())
      .then(
        (value) => {
          this.active--
          entry.resolve(value)
          this.tick()
        },
        (reason: unknown) => {
          this.active--
          entry.reject(reason)
          this.tick()
        }
      )
  }

  /** 取最高优先级任务下标；同优先级取先入队者（stable）。 */
  private nextIndex(): number {
    let best = 0
    let bestPriority = this.queue[0].job.priority()
    for (let i = 1; i < this.queue.length; i++) {
      const p = this.queue[i].job.priority()
      if (p > bestPriority) {
        bestPriority = p
        best = i
      }
    }
    return best
  }
}

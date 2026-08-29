/**
 * 请求中间件（W2.3）：统一超时 / 429 退避 / abort 透传 / 错误归一化。
 * 所有 Repository / Loader 的数据访问都走 fetchJson，禁止散落裸 fetch。
 */

/** HTTP 非 2xx 响应（status 可判）。 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message = `HTTP ${status}`
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 请求超时（区别于用户取消；调用方若需保持旧 AbortError 语义可单独捕获）。 */
export class TimeoutError extends Error {
  constructor(message = '请求超时') {
    super(message)
    this.name = 'TimeoutError'
  }
}

export interface FetchJsonOptions {
  /** 超时毫秒，默认 15000（与旧 withFetchTimeout 一致）。 */
  timeoutMs?: number
  /** 429 最大重试次数（不含首次），默认 2。 */
  maxRetries?: number
  /** 退避基数毫秒，默认 300；每次翻倍并叠加抖动。 */
  retryBaseMs?: number
  /** 是否在非 2xx 时抛 HttpError；默认 true。 */
  throwHttpErrors?: boolean
  headers?: HeadersInit
}

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_BASE_MS = 300
const RETRYABLE_STATUS = new Set([429])

/** 组合传入的取消信号与超时信号（供原始 fetch 场景复用，JSON 请求请直接用 fetchJson）。 */
export function withFetchTimeout(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
    : AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
}

/** 429 抖动记录：最近被限流的 URL → 时间戳（供 Loader/Scheduler 决定是否延后重试）。 */
const rateLimitHistory = new Map<string, number>()

export function markRateLimited(url: string): void {
  rateLimitHistory.set(url, Date.now())
}

export function wasRecentlyRateLimited(url: string, withinMs = 60_000): boolean {
  const t = rateLimitHistory.get(url)
  return t !== undefined && Date.now() - t < withinMs
}

/** 测试辅助：清空限流记录。 */
export function clearRateLimitHistory(): void {
  rateLimitHistory.clear()
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : (e as Error)?.name === 'AbortError'
}

/** 可被外部 signal 中断的延时（429 退避等待）。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(finish, ms)
    function finish(err?: unknown) {
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    function onAbort() {
      window.clearTimeout(timer)
      finish(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 统一 JSON 请求：
 * - 组合外部 signal 与超时（AbortSignal.any），用户取消抛 AbortError、超时抛 TimeoutError；
 * - 429 指数退避 + 抖动重试（可被外部 signal 中断），并记录限流历史；
 * - 非 2xx 默认抛 HttpError（throwHttpErrors=false 时返回原始 Response 供调用方细判）。
 */
export async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit,
  opts?: FetchJsonOptions
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES
  const retryBaseMs = opts?.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const signal: AbortSignal | undefined = init?.signal ?? undefined

  for (let attempt = 0; ; attempt++) {
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    try {
      const r = await fetch(url, { ...init, signal: combined })
      if (RETRYABLE_STATUS.has(r.status) && attempt < maxRetries) {
        markRateLimited(url)
        const jitter = Math.floor(Math.random() * (retryBaseMs / 2))
        await delay(retryBaseMs * 2 ** attempt + jitter, signal)
        continue
      }
      if (!r.ok && opts?.throwHttpErrors !== false) {
        throw new HttpError(r.status)
      }
      if (opts?.throwHttpErrors === false) {
        return r as unknown as T
      }
      return (await r.json()) as T
    } catch (e) {
      if (e instanceof HttpError) throw e
      if (isAbortError(e)) {
        // 用户取消：原样透传 AbortError；否则是组合信号超时 → 归一化为 TimeoutError。
        if (signal?.aborted) throw e
        throw new TimeoutError()
      }
      throw e
    }
  }
}

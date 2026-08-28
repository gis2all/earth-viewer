import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchJson, HttpError, TimeoutError, clearRateLimitHistory, wasRecentlyRateLimited } from './http'

function neverResponse(_url: string, opts?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
}

describe('fetchJson 请求中间件（W2.3）', () => {
  beforeEach(() => {
    clearRateLimitHistory()
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('成功返回解析后的 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ a: 1 }) })))
    await expect(fetchJson<{ a: number }>('https://x/api')).resolves.toEqual({ a: 1 })
  })

  it('非 2xx 抛 HttpError 并带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    await expect(fetchJson('https://x/missing')).rejects.toBeInstanceOf(HttpError)
    await expect(fetchJson('https://x/missing')).rejects.toMatchObject({ status: 404 })
  })

  it('throwHttpErrors=false 时原样返回 Response', async () => {
    const resp = { ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => resp))
    const out = await fetchJson('https://x/api', undefined, { throwHttpErrors: false })
    expect(out).toBe(resp)
  })

  it('用户取消 → 原样抛 AbortError', async () => {
    vi.stubGlobal('fetch', vi.fn(neverResponse))
    const ac = new AbortController()
    const p = fetchJson('https://x/api', { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('请求超时 → 归一化为 TimeoutError', async () => {
    vi.stubGlobal('fetch', vi.fn(neverResponse))
    await expect(fetchJson('https://x/slow', undefined, { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError)
  })

  it('429 指数退避重试后成功，并记录限流', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchJson<{ ok: boolean }>('https://x/limited', undefined, { retryBaseMs: 10, maxRetries: 2 })
    expect(out).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wasRecentlyRateLimited('https://x/limited')).toBe(true)
  })

  it('超过 maxRetries 的 429 最终抛 HttpError(429)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchJson('https://x/busy', undefined, { retryBaseMs: 5, maxRetries: 1 })).rejects.toMatchObject({
      name: 'HttpError',
      status: 429,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('退避等待期间被用户取消 → 立即抛 AbortError 且不重试', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const ac = new AbortController()
    const p = fetchJson('https://x/cancel', { signal: ac.signal }, { retryBaseMs: 10_000, maxRetries: 2 })
    // 等首次 429 响应落地、进入退避后再取消
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

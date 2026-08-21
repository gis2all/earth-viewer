import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import { fetchWebmap, detectMapService, withFetchTimeout } from '../globe/webmap'
import { assessWebmap, type WebmapAssessment } from '../globe/assess'

interface SearchResult {
  id: string
  title: string
  thumbnail?: string
  snippet?: string
  numViews?: number
  fidelity?: 'full' | 'partial' | 'none'
}

const DEFAULT_QUERY = 'type:"Web Map" AND access:public'
const PAGE = 24

function thumbUrl(id: string, t?: string): string | undefined {
  if (!t) return undefined
  return 'https://www.arcgis.com/sharing/rest/content/items/' + id + '/info/' + t
}

export function LayerPanel() {
  const collapsed = useAppStore((s) => s.collapsed)
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsed)
  const added = useAppStore((s) => s.added)
  const addLayer = useAppStore((s) => s.addLayer)
  const removeLayer = useAppStore((s) => s.removeLayer)
  const layerErrors = useAppStore((s) => s.layerErrors)

  const [kw, setKw] = useState('')
  const [items, setItems] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  const [addingId, setAddingId] = useState<string | null>(null)
  const nextStart = useRef(1)
  const loadingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const assessCache = useRef(new Map<string, WebmapAssessment>())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const kwRef = useRef(kw)
  kwRef.current = kw
  const timerRef = useRef<number | null>(null)

  /** 判断 webmap 是否至少有一个可渲染图层（带 url 的 MapServer/ImageServer/Feature/GeoJSON） */
  async function assessItem(it: SearchResult, signal?: AbortSignal): Promise<WebmapAssessment | null> {
    const cached = assessCache.current.get(it.id)
    if (cached) return cached
    try {
      const wm = await fetchWebmap(it.id, signal)
      const a = assessWebmap(wm as Record<string, unknown>)
      // 探测 MapServer/ImageServer 是否为动态服务（无 tileInfo）：动态服务无法用 /tile/ 渲染，降级为不可渲染
      await refineAssessment(a)
      assessCache.current.set(it.id, a)
      return a
    } catch {
      return null
    }
  }

  /** 对评估结果做异步精化：动态 MapServer 标为 none */
  async function refineAssessment(a: WebmapAssessment) {
    const tileLayers = a.layers.filter(
      (l) => l.support === 'full' && /\/MapServer\/?$|\/ImageServer\/?$/i.test(l.url ?? '')
    )
    if (tileLayers.length === 0) return
    const checks = await Promise.all(tileLayers.map((l) => detectMapService(l.url as string)))
    tileLayers.forEach((l, i) => {
      const info = checks[i]
      if (info && !info.tiled) {
        l.support = 'none'
        l.reason = '动态 MapServer（无缓存瓦片），暂不支持'
      }
    })
    // 重算 renderable / fidelity
    const renderable = a.layers.some(
      (l) => (l.role === 'basemap' || l.role === 'business') && (l.support === 'full' || l.support === 'partial')
    )
    a.renderable = renderable
    a.fidelity = renderable
      ? a.layers.some((l) => l.support !== 'full')
        ? 'partial'
        : 'full'
      : 'none'
    if (!renderable) {
      const first = a.layers.find((l) => l.reason)
      a.reason = first?.reason ?? '无可渲染图层'
    }
  }

  /** 分批检查（每批 6 个），控制并发避免触发限流；保留评估结果用于能力角标 */
  async function filterRenderable(items: SearchResult[], signal?: AbortSignal): Promise<SearchResult[]> {
    const out: SearchResult[] = []
    const BATCH = 6
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH)
      const flags = await Promise.all(batch.map((it) => assessItem(it, signal)))
      batch.forEach((it, idx) => {
        const a = flags[idx]
        if (a?.renderable) out.push({ ...it, fidelity: a.fidelity })
      })
    }
    return out
  }

  async function loadMore(reset: boolean) {
    if (loadingRef.current) return
    // 请求序列号：只有最新一次请求才允许更新 UI，彻底消除旧请求覆盖新结果的风险
    const requestId = ++requestIdRef.current
    // 取消上一个未完成的请求（防抖/新搜索时避免旧结果覆盖）
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    loadingRef.current = true
    setLoading(true)
    setErr('')
    try {
      let start = reset ? 1 : nextStart.current
      const usable: SearchResult[] = []
      let guard = 0
      // 预取 + 过滤：翻页直到凑够 PAGE 个可渲染的，或搜索到底
      while (usable.length < PAGE && guard < 12) {
        guard++
        const q = DEFAULT_QUERY + (kwRef.current ? ' AND ' + kwRef.current : '')
        const r = await fetch(
          '/sharing/rest/search?q=' + encodeURIComponent(q) + '&f=json&num=' + PAGE + '&start=' + start,
          { signal: withFetchTimeout(controller.signal) }
        )
        const j = (await r.json()) as {
          results?: SearchResult[]
          nextStart?: number
          total?: number
        }
        const results = (j.results ?? []).map((it) => ({
          id: it.id,
          title: it.title,
          thumbnail: it.thumbnail,
          snippet: it.snippet,
          numViews: it.numViews,
        }))
        nextStart.current = j.nextStart ?? start + results.length
        if (results.length === 0) {
          setDone(true)
          break
        }
        const ok = await filterRenderable(results, controller.signal)
        usable.push(...ok)
        if (!j.nextStart) {
          setDone(true)
          break
        }
        start = j.nextStart
      }
      // 按浏览数（view count）降序
      usable.sort((a, b) => (b.numViews ?? 0) - (a.numViews ?? 0))
      if (requestId !== requestIdRef.current) return
      if (reset) setItems(usable)
      else setItems((prev) => [...prev, ...usable])
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      if (requestId !== requestIdRef.current) return
      setErr('加载失败，请检查网络 / 代理')
    } finally {
      if (requestId === requestIdRef.current && abortRef.current === controller) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }

  const runSearch = () => {
    setItems([])
    setDone(false)
    setErr('')
    nextStart.current = 1
    void loadMore(true)
  }

  // 搜索防抖：停止输入 300ms 后才发起新搜索
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(runSearch, 300)
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw])

  // 回车立即搜索（跳过防抖）
  const submitSearch = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    runSearch()
  }

  // 取消进行中的搜索（递增序列号，使旧请求彻底失效）
  const cancelSearch = () => {
    requestIdRef.current++
    abortRef.current?.abort()
    loadingRef.current = false
    setLoading(false)
  }

  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)
  const notify = (msg: string) => {
    setToast(msg)
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 4000)
  }

  async function addWebmap(it: SearchResult) {
    if (addingId) return
    setAddingId(it.id)
    try {
      const wm = await fetchWebmap(it.id)
      addLayer({
        id: it.id,
        title: it.title,
        thumb: thumbUrl(it.id, it.thumbnail),
        itemId: it.id,
        webmap: wm as Record<string, unknown>,
        kind: 'webmap',
      })
      const a = assessWebmap(wm as Record<string, unknown>)
      const skipped = a.layers.filter((l) => l.support === 'none').map((l) => l.title).filter(Boolean)
      if (a.fidelity === 'partial' && skipped.length > 0) {
        notify('已添加，但部分图层不支持：' + skipped.join('、'))
      }
    } catch (e) {
      notify('添加失败：' + String(e))
    } finally {
      setAddingId(null)
    }
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200 && !loading && !done) {
      void loadMore(false)
    }
  }

  return (
    <aside className={'panel' + (collapsed ? ' collapsed' : '')}>
      <div className="side-head">
        <span className="side-title">图层</span>
        <button className="fold" onClick={toggleCollapsed} title={collapsed ? '展开面板' : '收起面板'}>
          {collapsed ? '›' : '‹'}
        </button>
      </div>
      <div className="panel-inner" ref={scrollRef} onScroll={onScroll}>
        <section className="group">
          <div className="group-head">
            <span className="group-name">已添加</span>
          </div>
          {added.length > 0 && (
            <div className="added-list">
              {added.map((l) => (
                <div key={l.id} className="added-card">
                  {l.thumb ? (
                    <img className="ac-thumb" src={l.thumb} alt={l.title} onError={(e) => (e.currentTarget.style.display = 'none')} />
                  ) : (
                    <div className="ac-ph" />
                  )}
                  <span className="added-title">{l.title}</span>
                  {layerErrors[l.id] && (
                    <span className="added-err" title={layerErrors[l.id]}>加载失败</span>
                  )}
                  <button className="remove-btn" onClick={() => removeLayer(l.id)} title="移除图层">
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="group">
          <div className="group-head">
            <span className="group-name lc">ArcGIS Online 数据源</span>
          </div>
          <div className="search">
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch()
              }}
              placeholder="搜索"
              aria-label="搜索 ArcGIS Online 数据源"
            />
            {loading && (
              <button className="search-cancel" onClick={cancelSearch} title="取消搜索" aria-label="取消搜索">
                ✕
              </button>
            )}
          </div>
          <div className="gallery">
            {items.map((it) => (
              <button
                key={it.id}
                className="gallery-card"
                onClick={() => addWebmap(it)}
                disabled={addingId === it.id}
                title={it.snippet}
              >
                {it.thumbnail ? (
                  <img
                    className="gc-thumb"
                    src={thumbUrl(it.id, it.thumbnail)}
                    alt={it.title}
                    loading="lazy"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                  />
                ) : (
                  <div className="gc-ph" />
                )}
                <span className="gc-title">{it.title}</span>
                {it.fidelity === 'partial' && (
                  <span className="gc-badge" title="部分图层暂不支持，添加时会跳过">部分支持</span>
                )}
              </button>
            ))}
          </div>
          {loading && (
            <div className="gallery-hint"><span className="dot" />加载中…</div>
          )}
          {done && !loading && items.length > 0 && (
            <div className="gallery-hint"><span className="dot" />已到底部</div>
          )}
          {err && <div className="gallery-hint err">{err}</div>}
        </section>
      </div>
      {toast && (
        <div className="layer-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </aside>
  )
}

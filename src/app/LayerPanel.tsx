import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import { fetchWebmap, withFetchTimeout } from '../globe/webmap'
import { assessWebmap } from '../globe/assess'
import { SEARCH_ITEM_TYPES, isWebMapContainer } from '../globe/itemTypes'
import { resolveServiceItem } from '../globe/serviceItem'

interface SearchResult {
  id: string
  title: string
  thumbnail?: string
  snippet?: string
  numViews?: number
  fidelity?: 'full' | 'partial' | 'none'
  url?: string
  type?: string
}

type SearchType = (typeof SEARCH_ITEM_TYPES)[number]

const SEARCH_TYPES: SearchType[] = [...SEARCH_ITEM_TYPES]
const SEARCH_PAGE = 12
const GALLERY_PAGE = 24
const APPEND_STEP = 12
/** 服务类 item 才需要服务根预检；容器（Web Map/Scene）与文件类走点开后校验。 */
const PREFLIGHT_TYPES = new Set<string>([
  'Map Service',
  'Feature Service',
  'Image Service',
  'Scene Service',
  'Vector Tile Service',
  'WMS',
  'WMTS',
  'WFS',
  'KML',
])
const PREFLIGHT_ABORT_MS = 3000
const PREFLIGHT_CACHE_KEY = 'earth-viewer:preflight'
const PREFLIGHT_TTL_MS = 24 * 60 * 60 * 1000

type PreflightState = 'ok' | 'bad'

function readPreflightCache(): Map<string, { s: PreflightState; t: number }> {
  try {
    const raw = localStorage.getItem(PREFLIGHT_CACHE_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, { s: PreflightState; t: number }>
    const now = Date.now()
    const map = new Map<string, { s: PreflightState; t: number }>()
    for (const [k, v] of Object.entries(obj)) {
      if (v && (v.s === 'ok' || v.s === 'bad') && now - v.t < PREFLIGHT_TTL_MS) map.set(k, v)
    }
    return map
  } catch {
    return new Map()
  }
}

function writePreflightCache(map: Map<string, { s: PreflightState; t: number }>) {
  try {
    localStorage.setItem(PREFLIGHT_CACHE_KEY, JSON.stringify(Object.fromEntries(map.entries())))
  } catch {
    /* 忽略配额/隐私限制 */
  }
}

/** 轻量探测服务根：Token Required / Subscription canceled / 403 等 => 不可用。 */
async function preflightService(url: string): Promise<boolean> {
  try {
    const sep = url.includes('?') ? '&' : '?'
    const r = await fetch(url + sep + 'f=json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(PREFLIGHT_ABORT_MS),
    })
    if (!r.ok) return false
    const j: unknown = await r.json().catch(() => null)
    const err = (j as { error?: unknown } | null)?.error
    return !!j && !err
  } catch {
    return false
  }
}


/** 按 item 类型选择预检方式：容器（Web Map/Scene）走 data（/sharing 代理），服务类走服务根。 */
async function preflightItem(it: SearchResult): Promise<boolean> {
  try {
    if (isWebMapContainer(it.type ?? '')) {
      const r = await fetch(`/sharing/rest/content/items/${it.id}/data?f=json`, {
        signal: AbortSignal.timeout(PREFLIGHT_ABORT_MS),
      })
      if (!r.ok) return false
      const j: unknown = await r.json().catch(() => null)
      return !!j && !(j as { error?: unknown } | null)?.error
    }
    if (it.url) return await preflightService(it.url)
    return true
  } catch {
    return false
  }
}

const AUTHORITATIVE_FILTER =
  'AND (contentstatus:"org_authoritative" OR contentstatus:"public_authoritative") NOT contentstatus:"deprecated"'

function buildSearchQuery(type: SearchType, keyword: string): string {
  const query = `type:"${type}" AND access:public ${AUTHORITATIVE_FILTER}`
  return keyword ? query + ' AND (' + keyword + ')' : query
}

function mergeSearchResults(groups: SearchResult[][]): SearchResult[] {
  const seen = new Set<string>()
  return groups
    .flat()
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .sort((a, b) => {
      const views = (b.numViews ?? 0) - (a.numViews ?? 0)
      return views || a.id.localeCompare(b.id)
    })
}

async function fetchSearchPage(
  type: SearchType,
  keyword: string,
  start: number,
  signal: AbortSignal
): Promise<{ results: SearchResult[]; nextStart?: number | null }> {
  const q = buildSearchQuery(type, keyword)
  const r = await fetch(
    '/sharing/rest/search?q=' +
      encodeURIComponent(q) +
      '&f=json&num=' +
      SEARCH_PAGE +
      '&start=' +
      start +
      '&sortField=numViews&sortOrder=desc',
    { signal: withFetchTimeout(signal) }
  )
  if (!r.ok) throw new Error('ArcGIS 搜索失败')
  const j = (await r.json()) as {
    results?: SearchResult[]
    nextStart?: number
  }
  return {
    results: (j.results ?? []).map((it) => ({
      id: it.id,
      title: it.title,
      thumbnail: it.thumbnail,
      snippet: it.snippet,
      numViews: it.numViews,
      url: it.url,
      type: it.type,
    })),
    nextStart: j.nextStart,
  }
}

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
  const loadingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const nextStartsRef = useRef<Record<string, number>>({})
  const doneTypesRef = useRef<Record<string, boolean>>({})
  const pendingRef = useRef<SearchResult[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const kwRef = useRef(kw)
  kwRef.current = kw
  const timerRef = useRef<number | null>(null)
  const [badIds, setBadIds] = useState<Set<string>>(() => {
    const cache = readPreflightCache()
    const set = new Set<string>()
    for (const [id, v] of cache) if (v.s === 'bad') set.add(id)
    return set
  })
  const preflightCacheRef = useRef<Map<string, { s: PreflightState; t: number }>>(readPreflightCache())
  const preflightGenRef = useRef(0)
  const preflightInflightRef = useRef<Set<string>>(new Set())

  async function loadMore(reset: boolean) {
    if (loadingRef.current && !reset) return
    const requestId = ++requestIdRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    loadingRef.current = true
    setLoading(true)
    setErr('')
    try {
      if (reset) {
        SEARCH_TYPES.forEach((t) => (nextStartsRef.current[t] = 1))
        SEARCH_TYPES.forEach((t) => (doneTypesRef.current[t] = false))
        pendingRef.current = []
      }
      // consume cached candidates, else fetch one page per unfinished type
      const needFetch = reset || pendingRef.current.length < APPEND_STEP
      if (needFetch) {
        const activeTypes = SEARCH_TYPES.filter((type) => !doneTypesRef.current[type])
        const pages = await Promise.all(
          activeTypes.map(async (type) => {
            const page = await fetchSearchPage(type, kwRef.current, nextStartsRef.current[type], controller.signal)
            if (requestId !== requestIdRef.current) return []
            if (!page.results.length || !page.nextStart) {
              doneTypesRef.current[type] = true
            } else {
              nextStartsRef.current[type] = page.nextStart
            }
            return page.results
          })
        )
        if (requestId !== requestIdRef.current) return
        const results = mergeSearchResults(pages)
        pendingRef.current = mergeSearchResults([pendingRef.current, results])
      }
      // ★ 旧请求即使 Abort 不及时，也不能让它污染新搜索的分页游标 / 待渲染缓冲
      if (requestId !== requestIdRef.current) return
      const take = reset ? GALLERY_PAGE : APPEND_STEP
      const toShow = pendingRef.current.slice(0, take)
      pendingRef.current = pendingRef.current.slice(take)
      if (requestId === requestIdRef.current && toShow.length > 0) {
        if (reset) setItems(toShow)
        else setItems((prev) => mergeSearchResults([prev, toShow]))
      }
      if (requestId === requestIdRef.current && SEARCH_TYPES.every((type) => doneTypesRef.current[type]) && pendingRef.current.length === 0) {
        setDone(true)
      }
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
    preflightGenRef.current++
    setItems([])
    setDone(false)
    setErr('')
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

  // 后台异步预检服务类卡片：命中需登录/订阅取消/不可访问 → 自动隐藏（不阻塞首屏）
  useEffect(() => {
    const cands = items.filter((it) => {
      const isContainer = isWebMapContainer(it.type ?? '')
      const isService = PREFLIGHT_TYPES.has(it.type ?? '')
      if (!(isContainer || isService)) return false
      if (isService && !it.url) return false
      return !preflightInflightRef.current.has(it.id) && !preflightCacheRef.current.has(it.id)
    })
    if (cands.length === 0) return
    const myGen = preflightGenRef.current
    const con = 4
    let idx = 0
    async function worker() {
      while (true) {
        const my = idx++
        if (my >= cands.length) break
        const it = cands[my]
        if (preflightInflightRef.current.has(it.id)) continue
        preflightInflightRef.current.add(it.id)
        try {
          const ok = await preflightItem(it)
          if (myGen !== preflightGenRef.current) return
          const cache = preflightCacheRef.current
          cache.set(it.id, { s: ok ? 'ok' : 'bad', t: Date.now() })
          if (!ok) {
            setBadIds((prev) => {
              const n = new Set(prev)
              n.add(it.id)
              return n
            })
          }
          writePreflightCache(cache)
        } catch {
          // 网络异常忽略，保留卡片（点开再校验）
        } finally {
          preflightInflightRef.current.delete(it.id)
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(con, cands.length) }, worker))
  }, [items])

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

  async function addItem(it: SearchResult) {
    if (addingId) return
    setAddingId(it.id)
    try {
      if (isWebMapContainer(it.type ?? '')) {
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
      } else {
        const layer = await resolveServiceItem({ id: it.id, type: it.type ?? '', url: it.url, title: it.title })
        if (!layer) {
          notify('暂不支持直接添加：' + (it.title || it.id))
          return
        }
        const wm = {
          baseMap: { baseMapLayers: [] },
          operationalLayers: [layer],
        }
        addLayer({
          id: it.id,
          title: it.title,
          thumb: thumbUrl(it.id, it.thumbnail),
          itemId: it.id,
          webmap: wm as unknown as Record<string, unknown>,
          kind: 'webmap',
        })
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
            {/* 取消/清除按钮：仅在有输入内容且加载中显示（无输入时初始自动加载不冒出来） */}
            {loading && kw.length > 0 && (
              <button className="search-cancel" onClick={cancelSearch} title="取消搜索" aria-label="取消搜索">
                ✕
              </button>
            )}
          </div>
          <div className="gallery">
            {items.filter((it) => !badIds.has(it.id)).map((it) => (
              <button
                key={it.id}
                className="gallery-card"
                onClick={() => addItem(it)}
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

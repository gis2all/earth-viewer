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
  contentStatus?: string
  groupDesignations?: string | string[]
  typeKeywords?: string[]
  tags?: string[]
}

type ItemMetadata = Pick<SearchResult, 'contentStatus' | 'groupDesignations'>

function textTerms(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
}

function isAuthoritative(item: SearchResult): boolean {
  const status = item.contentStatus?.trim().toLowerCase()
  return status === 'public_authoritative' || status === 'org_authoritative'
}

function isLivingAtlas(item: SearchResult): boolean {
  return textTerms(item.groupDesignations).includes('livingatlas')
}

function typeIconKind(type?: string): 'map' | 'scene' | 'feature' | 'image' | 'vector' | 'document' | 'table' | 'service' {
  const normalized = (type ?? '').toLowerCase()
  if (normalized.includes('web scene') || normalized.includes('scene service')) return 'scene'
  if (normalized.includes('feature')) return 'feature'
  if (normalized.includes('image') || normalized.includes('raster')) return 'image'
  if (normalized.includes('vector tile')) return 'vector'
  if (normalized.includes('kml') || normalized.includes('geojson')) return 'document'
  if (normalized.includes('csv')) return 'table'
  if (normalized.includes('map') || normalized.includes('wms') || normalized.includes('wmts') || normalized.includes('wfs')) return 'map'
  if (normalized.includes('service')) return 'service'
  return 'map'
}

function TypeIcon({ type }: { type?: string }) {
  const kind = typeIconKind(type)
  const common = { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (kind === 'scene') return <svg {...common}><path d="M2.2 5.1 8 2l5.8 3.1v5.8L8 14l-5.8-3.1V5.1Z" /><path d="m2.5 5.2 5.5 3 5.5-3M8 8.2V14" /></svg>
  if (kind === 'feature') return <svg {...common}><path d="m8 2.2 5.3 3.1v5.4L8 13.8l-5.3-3.1V5.3L8 2.2Z" /><circle cx="8" cy="8" r="1.35" /><path d="M8 4.4v1M8 10.6v1M4.4 8h1M10.6 8h1" /></svg>
  if (kind === 'image') return <svg {...common}><rect x="2.3" y="2.3" width="11.4" height="11.4" rx=".5" /><path d="m3.2 11.5 2.6-2.7 2.1 2 2.1-3 2.8 3.2M5.3 5.4h.01" /></svg>
  if (kind === 'vector') return <svg {...common}><path d="M3 3.2h4v4H3zM9 8.8h4v4H9zM7 5.2h2M5 7.2v1.6M7 10.8h2" /></svg>
  if (kind === 'document') return <svg {...common}><path d="M4 1.9h5l3 3v9.2H4V1.9Z" /><path d="M9 1.9v3h3M6 8h4M6 10.5h4" /></svg>
  if (kind === 'table') return <svg {...common}><rect x="2.3" y="2.3" width="11.4" height="11.4" /><path d="M2.5 6h11M2.5 9.5h11M6 2.5v11M10 2.5v11" /></svg>
  if (kind === 'service') return <svg {...common}><circle cx="8" cy="8" r="5.7" /><path d="M2.7 8h10.6M8 2.3c1.5 1.5 2.2 3.4 2.2 5.7S9.5 12.2 8 13.7C6.5 12.2 5.8 10.3 5.8 8S6.5 3.8 8 2.3Z" /></svg>
  return <svg {...common}><path d="m2.3 3.4 3.7-1.3 4 1.3 3.7-1.3v10.5l-3.7 1.3-4-1.3-3.7 1.3V3.4Z" /><path d="M6 2.2v10.4M10 3.4v10.5" /></svg>
}

function AuthorityIcon() {
  return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 1.9 1.6 1.7 2.4.2.2 2.4 1.7 1.8-1.7 1.8-.2 2.4-2.4.2L8 14.1l-1.6-1.7-2.4-.2-.2-2.4-1.7-1.8 1.7-1.8.2-2.4 2.4-.2L8 1.9Z" /><path d="m5.2 8.3 1.7 1.7 3.8-4" /></svg>
}

function LivingAtlasIcon() {
  return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.9 2.6C8.3 2.4 4.6 4.1 4.2 8c-.3 2.7 1.5 4.5 4.2 4.2 3.8-.5 4.6-5.5 4.5-9.6Z" /><path d="M3.1 13.5c1.1-3 3.2-5.2 6.2-6.4" /></svg>
}

function DetailIcon() {
  return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h8M5 8h8M5 12h8" /><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" /></svg>
}

function AddIcon({ added }: { added: boolean }) {
  if (added) return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.2 8.4 3.1 3.1 6.5-7" /></svg>
  return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
}

function ThumbSpinner() {
  return (
    <svg className="thumb-spinner" viewBox="0 0 28 28" aria-hidden="true">
      <circle className="track" cx="14" cy="14" r="11.5" />
      <path className="arc" d="M14 2.5 A 11.5 11.5 0 0 1 24.5 10.5" />
    </svg>
  )
}

function FoldIcon({ collapsed }: { collapsed: boolean }) {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d={collapsed ? 'm6 4 4 4-4 4' : 'm10 4-4 4 4 4'} /></svg>
}

function itemDetailsUrl(id: string): string {
  return 'https://www.arcgis.com/home/item.html?id=' + encodeURIComponent(id)
}

async function fetchItemMetadata(id: string, signal: AbortSignal): Promise<ItemMetadata | null> {
  try {
    const r = await fetch(`/sharing/rest/content/items/${encodeURIComponent(id)}?f=json`, { signal: withFetchTimeout(signal) })
    if (!r.ok) return null
    const value = (await r.json().catch(() => null)) as Record<string, unknown> | null
    if (!value || value.error) return null
    const contentStatus = typeof value.contentStatus === 'string' ? value.contentStatus : undefined
    const groupDesignations = Array.isArray(value.groupDesignations)
      ? value.groupDesignations.filter((v): v is string => typeof v === 'string')
      : typeof value.groupDesignations === 'string'
        ? value.groupDesignations
        : undefined
    return { contentStatus, groupDesignations }
  } catch {
    return null
  }
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
      contentStatus: it.contentStatus,
      groupDesignations: it.groupDesignations,
      typeKeywords: it.typeKeywords,
      tags: it.tags,
    })),
    nextStart: j.nextStart,
  }
}

function thumbUrl(id: string, t?: string): string | undefined {
  if (!t) return undefined
  return 'https://www.arcgis.com/sharing/rest/content/items/' + id + '/info/' + t
}

// 无缩略图 / 缩略图加载失败时的默认封面
const DEFAULT_COVER = import.meta.env.BASE_URL + 'covers/default.png'

// 缩略图请求可能长期 pending（既不到 load 也不到 error），超时后强制走回退链路
const THUMB_TIMEOUT_MS = 60000
export function thumbTimeout(img: HTMLImageElement, ms = THUMB_TIMEOUT_MS) {
  window.setTimeout(() => {
    if (img.complete) return // 已成功（naturalWidth>0，onLoad 已隐藏动画）或已失败（onError 已处理）
    if (!img.dataset.fb) {
      img.dataset.fb = '1'
      img.src = DEFAULT_COVER
      thumbTimeout(img, ms)
    } else {
      img.style.display = 'none'
      const spinner = img.previousElementSibling
      if (spinner && spinner.classList.contains('thumb-spinner')) spinner.setAttribute('hidden', '')
      img.nextElementSibling?.removeAttribute('hidden')
    }
  }, ms)
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
  const metadataGenRef = useRef(0)
  const metadataAttemptedRef = useRef<Set<string>>(new Set())
  const metadataInflightRef = useRef<Set<string>>(new Set())

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
    metadataGenRef.current++
    metadataAttemptedRef.current.clear()
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

  // 搜索结果缺少状态字段时，后台补充 item 元数据；状态图标不会依赖标题或 typeKeywords 猜测。
  useEffect(() => {
    const cands = items.filter((it) => {
      const missingMetadata = !it.contentStatus || !it.groupDesignations
      return missingMetadata && !metadataAttemptedRef.current.has(it.id) && !metadataInflightRef.current.has(it.id)
    })
    if (cands.length === 0) return
    const myGen = metadataGenRef.current
    let idx = 0
    async function worker() {
      while (true) {
        const my = idx++
        if (my >= cands.length) break
        const it = cands[my]
        metadataAttemptedRef.current.add(it.id)
        metadataInflightRef.current.add(it.id)
        try {
          const metadata = await fetchItemMetadata(it.id, abortRef.current?.signal ?? new AbortController().signal)
          if (myGen !== metadataGenRef.current || !metadata) continue
          if (!metadata.contentStatus && !metadata.groupDesignations) continue
          setItems((prev) => prev.map((current) => (current.id === it.id ? { ...current, ...metadata } : current)))
        } finally {
          metadataInflightRef.current.delete(it.id)
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, cands.length) }, worker))
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

  const scrollPage = (direction: -1 | 1) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ top: direction * Math.max(120, el.clientHeight * 0.8), behavior: 'smooth' })
  }

  return (
    <aside className={'panel' + (collapsed ? ' collapsed' : '')}>
      <div className="side-head">
        <span className="side-title">图层</span>
        <button className="fold" onClick={toggleCollapsed} title={collapsed ? '展开面板' : '收起面板'}>
          <FoldIcon collapsed={collapsed} />
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
                      <div className="ac-thumb-wrap">
                        <ThumbSpinner />
                        <img
                          className="ac-thumb"
                          src={l.thumb ?? DEFAULT_COVER}
                          alt={l.title}
                          ref={(el) => { if (el && !el.dataset.timerSet) { el.dataset.timerSet = '1'; thumbTimeout(el) } }}
                          onLoad={(e) => {
                            const sp = e.currentTarget.previousElementSibling
                            if (sp && sp.classList.contains('thumb-spinner')) sp.setAttribute('hidden', '')
                          }}
                          onError={(e) => {
                            const img = e.currentTarget
                            if (!img.dataset.fb) {
                              img.dataset.fb = '1'
                              img.src = DEFAULT_COVER
                            } else {
                              img.style.display = 'none'
                              const sp = img.previousElementSibling
                              if (sp && sp.classList.contains('thumb-spinner')) sp.setAttribute('hidden', '')
                            }
                          }}
                        />
                      </div>
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
            {items.filter((it) => !badIds.has(it.id)).map((it) => {
              const addedItem = added.some((layer) => layer.id === it.id)
              const loadingItem = addingId === it.id
              return (
                <article key={it.id} className="gallery-card" aria-label={it.title}>
                  <div className="gc-thumb-wrap">
                    <ThumbSpinner />
                    <img
                      className="gc-thumb"
                      src={it.thumbnail ? thumbUrl(it.id, it.thumbnail) : DEFAULT_COVER}
                      alt={it.title}
                      loading="lazy"
                      ref={(el) => { if (el && !el.dataset.timerSet) { el.dataset.timerSet = '1'; thumbTimeout(el) } }}
                      onLoad={(e) => {
                        const sp = e.currentTarget.previousElementSibling
                        if (sp && sp.classList.contains('thumb-spinner')) sp.setAttribute('hidden', '')
                      }}
                      onError={(e) => {
                        const img = e.currentTarget
                        if (!img.dataset.fb) {
                          img.dataset.fb = '1'
                          img.src = DEFAULT_COVER
                        } else {
                          img.style.display = 'none'
                          const sp = img.previousElementSibling
                          if (sp && sp.classList.contains('thumb-spinner')) sp.setAttribute('hidden', '')
                          img.nextElementSibling?.removeAttribute('hidden')
                        }
                      }}
                    />
                    <div className="gc-ph" hidden aria-hidden="true"><TypeIcon type={it.type} /></div>
                  </div>
                  <div className="gc-title" title={it.title}><span>{it.title}</span></div>
                  <div className="gc-foot">
                    <div className="gc-status" aria-label="图层状态">
                      <span className="gc-status-icon gc-type" title={it.type ?? '图层'} aria-label={it.type ?? '图层'}><TypeIcon type={it.type} /></span>
                      {isAuthoritative(it) && <span className="gc-status-icon gc-authoritative" title="权威数据" aria-label="权威数据"><AuthorityIcon /></span>}
                      {isLivingAtlas(it) && <span className="gc-status-icon gc-living" title="Living Atlas" aria-label="Living Atlas"><LivingAtlasIcon /></span>}
                    </div>
                    <a
                      className="gc-detail"
                      href={itemDetailsUrl(it.id)}
                      target="_blank"
                      rel="noreferrer"
                      title="查看详情"
                      aria-label={'查看 ' + it.title + ' 详情'}
                    >
                      <DetailIcon />
                    </a>
                    <button
                      className={'gc-add' + (addedItem ? ' is-added' : '') + (loadingItem ? ' is-loading' : '')}
                      onClick={() => void addItem(it)}
                      disabled={addedItem || loadingItem}
                      title={addedItem ? '已添加' : loadingItem ? '正在添加' : '添加数据'}
                      aria-label={addedItem ? '已添加 ' + it.title : '添加 ' + it.title}
                    >
                      {loadingItem ? <span className="gc-spinner" aria-hidden="true" /> : <AddIcon added={addedItem} />}
                    </button>
                  </div>
                </article>
              )
            })}
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
      <button className="scroll-arrow scroll-arrow-up" type="button" aria-label="向上滚动" onClick={() => scrollPage(-1)} />
      <button className="scroll-arrow scroll-arrow-down" type="button" aria-label="向下滚动" onClick={() => scrollPage(1)} />
      {toast && (
        <div className="layer-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </aside>
  )
}

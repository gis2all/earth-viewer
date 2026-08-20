import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'
import { fetchWebmap } from '../globe/webmap'
import { assessWebmap } from '../globe/assess'

interface SearchResult {
  id: string
  title: string
  thumbnail?: string
  snippet?: string
  numViews?: number
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

  const [kw, setKw] = useState('')
  const [items, setItems] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  const [addingId, setAddingId] = useState<string | null>(null)
  const nextStart = useRef(1)
  const loadingRef = useRef(false)
  const renderCache = useRef(new Map<string, boolean>())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const kwRef = useRef(kw)
  kwRef.current = kw

  /** 判断 webmap 是否至少有一个可渲染图层（带 url 的 MapServer/ImageServer/Feature/GeoJSON） */
  async function checkRenderable(it: SearchResult): Promise<boolean> {
    const cached = renderCache.current.get(it.id)
    if (cached !== undefined) return cached
    try {
      const wm = await fetchWebmap(it.id)
      const ok = assessWebmap(wm as Record<string, unknown>).renderable
      renderCache.current.set(it.id, ok)
      return ok
    } catch {
      renderCache.current.set(it.id, false)
      return false
    }
  }

  /** 分批检查（每批 6 个），控制并发避免触发限流 */
  async function filterRenderable(items: SearchResult[]): Promise<SearchResult[]> {
    const out: SearchResult[] = []
    const BATCH = 6
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH)
      const flags = await Promise.all(batch.map(checkRenderable))
      batch.forEach((it, idx) => {
        if (flags[idx]) out.push(it)
      })
    }
    return out
  }

  async function loadMore(reset: boolean) {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setErr('')
    try {
      let start = reset ? 1 : nextStart.current
      let usable: SearchResult[] = []
      let guard = 0
      // 预取 + 过滤：翻页直到凑够 PAGE 个可渲染的，或搜索到底
      while (usable.length < PAGE && guard < 12) {
        guard++
        const q = DEFAULT_QUERY + (kwRef.current ? ' AND ' + kwRef.current : '')
        const r = await fetch(
          '/sharing/rest/search?q=' + encodeURIComponent(q) + '&f=json&num=' + PAGE + '&start=' + start
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
        const ok = await filterRenderable(results)
        usable.push(...ok)
        if (!j.nextStart) {
          setDone(true)
          break
        }
        start = j.nextStart
      }
      // 按浏览数（view count）降序
      usable.sort((a, b) => (b.numViews ?? 0) - (a.numViews ?? 0))
      if (reset) setItems(usable)
      else setItems((prev) => [...prev, ...usable])
    } catch (e) {
      setErr('加载失败，请检查网络 / 代理')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }

  useEffect(() => {
    setItems([])
    setDone(false)
    setErr('')
    nextStart.current = 1
    void loadMore(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kw])

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
    } catch (e) {
      setErr('添加失败：' + String(e))
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
                    <img className="ac-thumb" src={l.thumb} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  ) : (
                    <div className="ac-ph" />
                  )}
                  <span className="added-title">{l.title}</span>
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
              placeholder="搜索"
            />
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
                    alt=""
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
    </aside>
  )
}

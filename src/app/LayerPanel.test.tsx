import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { LayerPanel, thumbTimeout } from './LayerPanel'
import { useAppStore } from './store'

const searchResponse = {
  results: [{ id: 'wm1', title: 'Test Imagery', thumbnail: null, numViews: 100 }],
  nextStart: null,
  total: 1,
}

const webmapData = {
  baseMap: {
    baseMapLayers: [
      { title: 'Imagery', url: 'https://x/World_Imagery/MapServer', layerType: 'ArcGISTiledMapServiceLayer' },
    ],
  },
  operationalLayers: [],
}

describe('LayerPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ added: [], collapsed: false, collapsedRight: false })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('输入关键词防抖后渲染搜索结果卡片', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/sharing/rest/search')) {
          return { ok: true, json: async () => searchResponse }
        }
        // webmap data
        return { ok: true, json: async () => webmapData }
      })
    )
    render(<LayerPanel />)
    const input = screen.getByPlaceholderText('搜索')
    fireEvent.change(input, { target: { value: 'imagery' } })
    await waitFor(() => expect(screen.getByText('Test Imagery')).toBeInTheDocument(), { timeout: 8000 })
  })

  it('图片 alt 使用图层标题', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/sharing/rest/search')) {
          return { ok: true, json: async () => ({ ...searchResponse, results: [{ id: 'wm1', title: 'Test Imagery', thumbnail: 'thumb.png', numViews: 1 }] }) }
        }
        return { ok: true, json: async () => webmapData }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Test Imagery')).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.getByAltText('Test Imagery')).toBeInTheDocument()
  })

  it('长标题使用独立文本节点承载省略号样式和完整 tooltip', async () => {
    const title = 'A very long layer title that should be truncated inside the card'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/sharing/rest/search')) {
          return { ok: true, json: async () => ({ ...searchResponse, results: [{ id: 'wm1', title, thumbnail: null, numViews: 1 }] }) }
        }
        return { ok: true, json: async () => webmapData }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText(title)).toBeInTheDocument(), { timeout: 8000 })
    const titleBox = screen.getByText(title).parentElement
    expect(titleBox).toHaveClass('gc-title')
    expect(titleBox).toHaveAttribute('title', title)
  })

  it('卡片按 ArcGIS 元数据显示状态图标，详情与添加操作彼此独立', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return {
            ok: true,
            json: async () => ({
              results: [{
                id: 'wm1',
                title: 'Test Imagery',
                thumbnail: null,
                numViews: 1,
                type: 'Web Map',
                contentStatus: 'public_authoritative',
                groupDesignations: 'livingatlas',
              }],
              nextStart: null,
              total: 1,
            }),
          }
        }
        return { ok: true, json: async () => webmapData }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Test Imagery')).toBeInTheDocument(), { timeout: 8000 })

    expect(screen.getByRole('article', { name: 'Test Imagery' })).toBeInTheDocument()
    expect(screen.getByLabelText('Web Map')).toBeInTheDocument()
    expect(screen.getByLabelText('权威数据')).toBeInTheDocument()
    expect(screen.getByLabelText('Living Atlas')).toBeInTheDocument()
    const detailLink = screen.getByRole('link', { name: '查看 Test Imagery 详情' })
    expect(detailLink).toHaveAttribute('href', expect.stringContaining('wm1'))
    expect(detailLink.parentElement).toHaveClass('gc-foot')
    expect(detailLink.nextElementSibling).toHaveClass('gc-add')
    expect(detailLink.closest('.gc-title')).toBeNull()
    expect(detailLink.closest('.gc-thumb-wrap')).toBeNull()

    fireEvent.click(screen.getByText('Test Imagery'))
    expect(useAppStore.getState().added).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '添加 Test Imagery' }))
    await waitFor(() => expect(useAppStore.getState().added.some((item) => item.id === 'wm1')).toBe(true))
  })

  it('搜索结果缺少状态时补充 item 元数据，并且不把普通 Living Atlas 标签当作状态', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        urls.push(u)
        if (u.includes('/sharing/rest/search')) {
          return {
            ok: true,
            json: async () => ({
              results: [{
                id: 'wm1',
                title: 'Metadata Item',
                thumbnail: null,
                numViews: 1,
                type: 'Web Map',
                typeKeywords: ['ArcGIS Online', 'Web Map'],
                tags: ['Living Atlas'],
              }],
              nextStart: null,
              total: 1,
            }),
          }
        }
        if (u.includes('/content/items/wm1?f=json')) {
          return { ok: true, json: async () => ({ contentStatus: 'public_authoritative', groupDesignations: ['livingatlas'] }) }
        }
        return { ok: true, json: async () => webmapData }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Metadata Item')).toBeInTheDocument(), { timeout: 8000 })
    expect(urls.some((url) => url.includes('/content/items/wm1?f=json'))).toBe(true)
    await waitFor(() => expect(screen.getByLabelText('权威数据')).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.getByLabelText('Living Atlas')).toBeInTheDocument()
  })

  it('没有明确 groupDesignations 时不显示 Living Atlas 图标', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ id: 'wm1', title: 'Plain Item', thumbnail: null, numViews: 1, type: 'Web Map', tags: ['Living Atlas'] }],
              nextStart: null,
              total: 1,
            }),
          }
        }
        if (u.includes('/content/items/wm1?f=json')) {
          return { ok: true, json: async () => ({ contentStatus: 'public_authoritative' }) }
        }
        return { ok: true, json: async () => webmapData }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Plain Item')).toBeInTheDocument(), { timeout: 8000 })
    await waitFor(() => expect(screen.getByLabelText('权威数据')).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.queryByLabelText('Living Atlas')).not.toBeInTheDocument()
  })

  it('默认搜索同时获取 Web Map 和 Web Scene，并合并为不重复的画廊结果', async () => {
    const queries: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          const q = new URL(u, 'http://localhost').searchParams.get('q') ?? ''
          queries.push(q)
          const isScene = q.includes('Web Scene')
          return {
            ok: true,
            json: async () => ({
              results: [
                {
                  id: isScene ? 'scene-1' : 'map-1',
                  title: isScene ? 'Test Scene' : 'Test Map',
                  thumbnail: null,
                  numViews: isScene ? 200 : 100,
                },
              ],
              nextStart: null,
              total: 1,
            }),
          }
        }
        return { ok: true, json: async () => webmapData }
      })
    )

    render(<LayerPanel />)

    await waitFor(() => expect(screen.getByText('Test Map')).toBeInTheDocument(), { timeout: 8000 })
    await waitFor(() => expect(screen.getByText('Test Scene')).toBeInTheDocument(), { timeout: 8000 })
    expect(queries.some((q) => q.includes('type:"Web Map"'))).toBe(true)
    expect(queries.some((q) => q.includes('type:"Web Scene"'))).toBe(true)
  })

  it('Web Scene 数据可进入画廊并添加到同一个地球图层状态', async () => {
    const sceneData = {
      operationalLayers: [],
      baseMap: {
        baseMapLayers: [
          {
            title: 'Buildings',
            url: 'https://basemaps3d.arcgis.com/arcgis/rest/services/Esri3D_Buildings_v1/SceneServer/layers/0',
            layerType: 'ArcGISSceneServiceLayer',
          },
        ],
      },
      viewingMode: 'global',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          const q = new URL(u, 'http://localhost').searchParams.get('q') ?? ''
          const isScene = q.includes('Web Scene')
          return {
            ok: true,
            json: async () => ({
              results: [{ id: isScene ? 'scene-1' : 'map-1', title: isScene ? 'Scene Item' : 'Map Item', thumbnail: null, numViews: 10, type: isScene ? 'Web Scene' : 'Web Map' }],
              nextStart: null,
              total: 1,
            }),
          }
        }
        if (u.includes('/items/scene-1/data')) return { ok: true, json: async () => sceneData }
        return { ok: true, json: async () => webmapData }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Scene Item')).toBeInTheDocument(), { timeout: 8000 })
    fireEvent.click(screen.getByRole('button', { name: /Scene Item/ }))
    await waitFor(() => expect(useAppStore.getState().added.some((item) => item.id === 'scene-1')).toBe(true))
    expect(useAppStore.getState().added.find((item) => item.id === 'scene-1')?.webmap).toEqual(sceneData)
  })

  it('关键词包含 OR 时加括号，保持 Web Map/Web Scene 与公开条件的优先级', async () => {
    const queries: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/sharing/rest/search')) {
        queries.push(new URL(u, 'http://localhost').searchParams.get('q') ?? '')
        return { ok: true, json: async () => ({ results: [], nextStart: null, total: 0 }) }
      }
      return { ok: true, json: async () => webmapData }
    }))
    render(<LayerPanel />)
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: 'roads OR streets' } })
    await waitFor(() => expect(queries.length).toBeGreaterThanOrEqual(2), { timeout: 8000 })
    expect(queries.every((query) => query.includes(' AND (roads OR streets)'))).toBe(true)
  })
})


// ---- 补强：流式渲染 / 翻页 / 到底 / 取消 / 添加 / 移除 / 角标 / toast ----
function stubGalleryFetch(
  pages: { id: string; title: string; thumbnail?: string | null; numViews?: number }[][],
  renderableIds: string[],
  webmapOverrides?: Record<string, unknown>
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/sharing/rest/search')) {
        const usp = new URL(u, 'http://localhost').searchParams
        const q = usp.get('q') ?? ''
        if (!q.includes('Web Map')) {
          return { ok: true, json: async () => ({ results: [], nextStart: null, total: 0 }) }
        }
        const m = /start=(\d+)/.exec(u)
        const start = m ? Number(m[1]) : 1
        const idx = Math.floor((start - 1) / 24)
        const results = (pages[idx] ?? []).map((x) => ({ ...x, type: 'Web Map' }))
        return {
          ok: true,
          json: async () => ({
            results,
            nextStart: results.length ? start + results.length : null,
            total: 10000,
          }),
        }
      }
      if (u.includes('/sharing/rest/content/items/')) {
        const id = /items\/([^/]+)\/data/.exec(u)?.[1] ?? ''
        if (renderableIds.includes(id)) {
          return { ok: true, json: async () => webmapOverrides ?? webmapData }
        }
        return {
          ok: true,
          json: async () => ({
            baseMap: { baseMapLayers: [{ title: 'Streets', url: '', layerType: 'VectorTileLayer' }] },
            operationalLayers: [],
          }),
        }
      }
      // detectMapService 直连：tiled 服务
      return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) }
    })
  )
}

describe('LayerPanel 画廊补强', () => {
  beforeEach(() => {
    useAppStore.setState({ added: [], collapsed: false, collapsedRight: false, layerErrors: {} })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('搜索结果全部上屏（轻预筛，不再按可渲染过滤）', async () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ id: 'wm' + i, title: 'Layer ' + i, thumbnail: null, numViews: 100 - i }))
    stubGalleryFetch([items], items.map((x) => x.id))
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getAllByText(/^Layer /)).toHaveLength(24), { timeout: 8000 })
  })

  it('轻预筛一页一页拉：首屏展示单页，滚动到底触发翻页', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => ({ id: 'p1-' + i, title: 'Hit ' + i, thumbnail: null, numViews: 100 - i }))
    const page2 = Array.from({ length: 24 }, (_, i) => ({ id: 'p2-' + i, title: 'Miss ' + i, thumbnail: null, numViews: 1 }))
    stubGalleryFetch([page1, page2], [...page1.map((x) => x.id), ...page2.map((x) => x.id)])
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getAllByText(/^Hit /)).toHaveLength(24), { timeout: 10000 })
    expect(screen.queryByText(/^Miss /)).not.toBeInTheDocument()
    const inner = document.querySelector('.panel-inner') as HTMLElement
    Object.defineProperty(inner, 'scrollTop', { value: 10000, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(inner, 'scrollHeight', { value: 10000, configurable: true })
    fireEvent.scroll(inner)
    await waitFor(() => expect(screen.getAllByText(/^Miss /)).toHaveLength(12), { timeout: 10000 })
  })

  it('加载中可取消搜索（abort 后停止）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      })
    )
    render(<LayerPanel />)
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: 'quake' } })
    const cancel = await screen.findByLabelText('取消搜索')
    fireEvent.click(cancel)
    await waitFor(() => expect(screen.queryByLabelText('取消搜索')).not.toBeInTheDocument())
  })

  it('未输入搜索内容时不显示取消按钮（初始自动加载也不出现）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      })
    )
    render(<LayerPanel />)
    // 等初始自动搜索进入 loading（防抖 300ms 后），无输入 → 按钮仍不应出现
    await new Promise((r) => setTimeout(r, 600))
    expect(screen.queryByLabelText('取消搜索')).not.toBeInTheDocument()
  })

  it('点击卡片添加图层到 store', async () => {
    stubGalleryFetch([[{ id: 'wm1', title: 'Imagery', thumbnail: null, numViews: 10 }]], ['wm1'])
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Imagery')).toBeInTheDocument(), { timeout: 8000 })
    fireEvent.click(screen.getAllByRole('button', { name: /Imagery/ })[0])
    await waitFor(() => expect(useAppStore.getState().added.some((l) => l.id === 'wm1')).toBe(true))
  })

  it('移除已添加图层', async () => {
    useAppStore.getState().addLayer({ id: 'x1', title: 'Added', kind: 'fallback' })
    render(<LayerPanel />)
    expect(screen.getByText('Added')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('移除图层'))
    await waitFor(() => expect(useAppStore.getState().added).toHaveLength(0))
  })

  it('轻预筛下不再展示“部分支持”角标（添加时才提示）', async () => {
    const webmapPartial = {
      baseMap: { baseMapLayers: [{ title: 'Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }] },
      operationalLayers: [{ id: 'f', title: 'Feat', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }],
    }
    stubGalleryFetch([[{ id: 'wm1', title: 'Partial', thumbnail: null, numViews: 5 }]], ['wm1'], webmapPartial)
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Partial')).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.queryByText('部分支持')).not.toBeInTheDocument()
  })

  it('添加图层失败 → toast 提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return { ok: true, json: async () => ({ results: [{ id: 'wm1', title: 'Broken', thumbnail: null, numViews: 1, type: 'Web Map' }], nextStart: null, total: 1 }) }
        }
        if (u.includes('/sharing/rest/content/items/')) throw new Error('boom')
        return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Broken')).toBeInTheDocument(), { timeout: 8000 })
    fireEvent.click(screen.getAllByRole('button', { name: /Broken/ })[0])
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/添加失败/), { timeout: 8000 })
  }, 15000)

  it('滚动到底部触发加载更多（第二页）', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => ({ id: 's1-' + i, title: 'P1 ' + i, thumbnail: null, numViews: 100 - i }))
    const page2 = Array.from({ length: 24 }, (_, i) => ({ id: 's2-' + i, title: 'P2 ' + i, thumbnail: null, numViews: 1 }))
    stubGalleryFetch([page1, page2], [...page1.map((x) => x.id), ...page2.map((x) => x.id)])
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getAllByText(/^P1 /)).toHaveLength(24), { timeout: 10000 })
    const inner = document.querySelector('.panel-inner') as HTMLElement
    Object.defineProperty(inner, 'scrollTop', { value: 10000, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(inner, 'scrollHeight', { value: 10000, configurable: true })
    fireEvent.scroll(inner)
    await waitFor(() => expect(screen.getAllByText(/^P2 /)).toHaveLength(12), { timeout: 10000 })
  }, 20000)

  it('已添加图层带缩略图时渲染 img', () => {
    useAppStore.getState().addLayer({ id: 't1', title: 'ThumbLayer', thumb: 'https://x/t.png', kind: 'fallback' })
    render(<LayerPanel />)
    const img = screen.getByAltText('ThumbLayer') as HTMLImageElement
    expect(img.className).toBe('ac-thumb')
  })

  it('画廊卡片缩略图加载失败时回退默认封面，默认封面也失败则隐藏', async () => {
    stubGalleryFetch([[{ id: 'wm1', title: 'Thumb', thumbnail: 't.png', numViews: 1 }]], ['wm1'])
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByAltText('Thumb')).toBeInTheDocument(), { timeout: 8000 })
    const img = screen.getAllByAltText('Thumb')[0] as HTMLImageElement
    const spinner = img.closest('.gc-thumb-wrap')?.querySelector('.thumb-spinner')
    expect(spinner).not.toHaveAttribute('hidden')
    fireEvent.error(img)
    expect(img.src).toContain('covers/default.png')
    expect(spinner).not.toHaveAttribute('hidden')
    fireEvent.error(img)
    expect(img.style.display).toBe('none')
    expect(spinner).toHaveAttribute('hidden')
    expect(img.nextElementSibling).not.toHaveAttribute('hidden')
  })

  it('画廊卡片缩略图加载完成后隐藏加载动画', async () => {
    stubGalleryFetch([[{ id: 'wm1', title: 'Thumb', thumbnail: 't.png', numViews: 1 }]], ['wm1'])
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByAltText('Thumb')).toBeInTheDocument(), { timeout: 8000 })
    const img = screen.getAllByAltText('Thumb')[0] as HTMLImageElement
    const spinner = img.closest('.gc-thumb-wrap')?.querySelector('.thumb-spinner')
    expect(spinner).not.toHaveAttribute('hidden')
    fireEvent.load(img)
    expect(spinner).toHaveAttribute('hidden')
  })

  it('缩略图请求长期挂起时超时回退默认封面，再超时结束加载态', () => {
    vi.useFakeTimers()
    try {
      const wrap = document.createElement('div')
      const spinner = document.createElement('div')
      spinner.className = 'thumb-spinner'
      const img = document.createElement('img')
      img.alt = 'Thumb'
      img.src = 'https://x/pending.png' // 模拟请求长期 pending（jsdom 不加载，complete 保持 false）
      const ph = document.createElement('div')
      ph.setAttribute('hidden', '')
      wrap.append(spinner, img, ph)
      thumbTimeout(img)
      vi.advanceTimersByTime(60000)
      expect(img.dataset.fb).toBe('1')
      expect(img.src).toContain('covers/default.png')
      expect(spinner).not.toHaveAttribute('hidden')
      vi.advanceTimersByTime(60000)
      expect(img.style.display).toBe('none')
      expect(spinner).toHaveAttribute('hidden')
      expect(ph).not.toHaveAttribute('hidden')
    } finally {
      vi.useRealTimers()
    }
  })


  it('stale search must not poison next search paging cursor', async () => {
    const recorders: Array<{ kind: string; type?: string; start?: number; resolve?: (v: unknown) => void }> = []
    vi.stubGlobal('fetch', vi.fn((url) => {
      const u = String(url)
      return new Promise((resolve) => {
        if (u.includes('/sharing/rest/search')) {
          const usp = new URL(u, 'http://localhost').searchParams
          const q = usp.get('q') ?? ''
          const start = Number(usp.get('start') ?? 1)
          const type = q.includes('Web Scene') ? 'Web Scene' : q.includes('Web Map') ? 'Web Map' : 'other'
          recorders.push({ kind: 'search', type, start, resolve })
          if (type === 'other') resolve({ ok: true, json: async () => ({ results: [], nextStart: null, total: 0 }) })
        } else if (u.includes('/sharing/rest/content/items/')) {
          resolve({ ok: true, json: async () => webmapData })
        } else {
          resolve({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) })
        }
      })
    }))

    render(<LayerPanel />)
    await waitFor(() => expect(recorders.filter((r) => r.kind === 'search')).toHaveLength(13), { timeout: 8000 })
    const s0 = recorders.filter((r) => r.kind === 'search')
    const oldScene = s0[1]

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'quake' } })
    await waitFor(() => expect(recorders.filter((r) => r.kind === 'search')).toHaveLength(26), { timeout: 8000 })
    const s1 = recorders.filter((r) => r.kind === 'search')
    const bMap = s1[13]
    const bScene = s1[14]

    oldScene.resolve?.({ ok: true, json: async () => ({ results: [], nextStart: null, total: 0 }) })

    const mk = (prefix: string, base: number) =>
      Array.from({ length: 6 }, (_, i) => ({ id: prefix + (base + i), title: prefix + (base + i), thumbnail: null, numViews: base + i }))
    bMap.resolve?.({ ok: true, json: async () => ({ results: mk('m', 0), nextStart: 13, total: 100 }) })
    bScene.resolve?.({ ok: true, json: async () => ({ results: mk('w', 6), nextStart: 25, total: 100 }) })

    await waitFor(() => expect(screen.getAllByText(/^m/)).toHaveLength(6), { timeout: 8000 })

    const inner = document.querySelector('.panel-inner') as HTMLElement
    Object.defineProperty(inner, 'scrollTop', { value: 10000, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(inner, 'scrollHeight', { value: 10000, configurable: true })
    fireEvent.scroll(inner)
    await waitFor(
      () => expect(recorders.some((r) => r.kind === 'search' && r.type === 'Web Scene' && r.start === 25)).toBe(true),
      { timeout: 8000 }
    )
  }, 15000)
  it('stale search with poisoned nextStart must not overwrite the new search cursor', async () => {
    const recorders: Array<{ kind: string; type?: string; start?: number; resolve?: (v: unknown) => void }> = []
    vi.stubGlobal('fetch', vi.fn((url) => {
      const u = String(url)
      return new Promise((resolve) => {
        if (u.includes('/sharing/rest/search')) {
          const usp = new URL(u, 'http://localhost').searchParams
          const q = usp.get('q') ?? ''
          const start = Number(usp.get('start') ?? 1)
          const type = q.includes('Web Scene') ? 'Web Scene' : q.includes('Web Map') ? 'Web Map' : 'other'
          recorders.push({ kind: 'search', type, start, resolve })
          if (type === 'other') resolve({ ok: true, json: async () => ({ results: [], nextStart: null, total: 0 }) })
        } else if (u.includes('/sharing/rest/content/items/')) {
          resolve({ ok: true, json: async () => webmapData })
        } else {
          resolve({ ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) })
        }
      })
    }))

    render(<LayerPanel />)
    await waitFor(() => expect(recorders.filter((r) => r.kind === 'search')).toHaveLength(13), { timeout: 8000 })
    const s0 = recorders.filter((r) => r.kind === 'search')
    const oldScene = s0.find((r) => r.type === 'Web Scene')!

    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'quake' } })
    await waitFor(() => expect(recorders.filter((r) => r.kind === 'search')).toHaveLength(26), { timeout: 8000 })
    const s1 = recorders.filter((r) => r.kind === 'search')
    const bMap = s1[13]
    const bScene = s1[14]

    const mk = (prefix: string, base: number) =>
      Array.from({ length: 6 }, (_, i) => ({ id: prefix + (base + i), title: prefix + (base + i), thumbnail: null, numViews: base + i }))
    // New search resolves first, writing the CORRECT cursors (Web Map 13 / Web Scene 25).
    bMap.resolve?.({ ok: true, json: async () => ({ results: mk('m', 0), nextStart: 13, total: 100 }) })
    bScene.resolve?.({ ok: true, json: async () => ({ results: mk('w', 6), nextStart: 25, total: 100 }) })
    await waitFor(() => expect(screen.getAllByText(/^m/)).toHaveLength(6), { timeout: 8000 })

    // THEN the stale old request resolves with a poisoned nextStart (999).
    // If unguarded it would overwrite the Web Scene cursor and make paging jump to 999.
    oldScene.resolve?.({
      ok: true,
      json: async () => ({ results: [{ id: 'stale-scene', title: 'Stale', thumbnail: null, numViews: 0 }], nextStart: 999, total: 100 }),
    })
    // Let any stale write flush before paging.
    await new Promise((r) => setTimeout(r, 50))

    const inner = document.querySelector('.panel-inner') as HTMLElement
    Object.defineProperty(inner, 'scrollTop', { value: 10000, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 600, configurable: true })
    Object.defineProperty(inner, 'scrollHeight', { value: 10000, configurable: true })
    fireEvent.scroll(inner)
    await waitFor(
      () => expect(recorders.some((r) => r.kind === 'search' && r.type === 'Web Scene' && r.start === 25)).toBe(true),
      { timeout: 8000 }
    )
    // No poisoned request was ever issued for Web Scene.
    expect(recorders.some((r) => r.kind === 'search' && r.type === 'Web Scene' && r.start === 999)).toBe(false)
  }, 15000)

})


describe('LayerPanel 边界与错误路径', () => {
  beforeEach(() => {
    useAppStore.setState({ added: [], collapsed: false, collapsedRight: false, layerErrors: {} })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('搜索请求失败 → 显示加载失败提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('boom') }))
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('加载失败，请检查网络 / 代理')).toBeInTheDocument(), { timeout: 8000 })
  })

  it('按 Enter 立即搜索（跳过防抖）', async () => {
    stubGalleryFetch([[{ id: 'wm1', title: 'EnterHit', thumbnail: null, numViews: 5 }]], ['wm1'])
    render(<LayerPanel />)
    fireEvent.keyDown(screen.getByPlaceholderText('搜索'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('EnterHit')).toBeInTheDocument(), { timeout: 8000 })
  })

  it('动态 MapServer 转为可添加', async () => {
    const wmDyn = {
      baseMap: { baseMapLayers: [] },
      operationalLayers: [{ id: 'dyn', title: 'Dynamic Supported', url: 'https://dyn/MapServer', layerType: 'ArcGISMapServiceLayer' }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return { ok: true, json: async () => ({ results: [{ id: 'wm1', title: 'Dynamic Supported', thumbnail: null, numViews: 1 }], nextStart: null, total: 1 }) }
        }
        if (u.includes('/sharing/rest/content/items/')) return { ok: true, json: async () => wmDyn }
        return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 } }) }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Dynamic Supported')).toBeInTheDocument(), { timeout: 8000 })
  })


  it('service item (Map Service) 可添加并包装为图层', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ id: 'svc1', title: 'Hillshade', thumbnail: null, numViews: 5, type: 'Map Service', url: 'https://x/MapServer' }],
              nextStart: null,
              total: 1,
            }),
          }
        }
        return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Hillshade')).toBeInTheDocument(), { timeout: 8000 })
    fireEvent.click(screen.getAllByRole('button', { name: /Hillshade/ })[0])
    await waitFor(() => expect(useAppStore.getState().added.some((l) => l.id === 'svc1')).toBe(true))
    const added = useAppStore.getState().added.find((l) => l.id === 'svc1')
    expect((added?.webmap as unknown as { operationalLayers?: { layerType?: string }[] })?.operationalLayers?.[0]?.layerType).toBe('ArcGISMapServiceLayer')
  })

  it('服务类预检不可用（Token Required）→ 自动隐藏卡片', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return {
            ok: true,
            json: async () => ({
              results: [{ id: 'fs1', title: 'RKI RequireLogin', thumbnail: null, numViews: 20, type: 'Feature Service', url: 'https://x/FeatureServer' }],
              nextStart: null,
              total: 1,
            }),
          }
        }
        if (u.includes('/FeatureServer') && u.includes('f=json')) return { ok: true, json: async () => ({ error: { code: 499, message: 'Token Required' } }) }
        return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 } }) }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('RKI RequireLogin')).toBeInTheDocument(), { timeout: 8000 })
    await waitFor(() => expect(screen.queryByText('RKI RequireLogin')).not.toBeInTheDocument(), { timeout: 8000 })
  })

})

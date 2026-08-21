import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { LayerPanel } from './LayerPanel'
import { useAppStore } from '../state/store'

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
        const m = /start=(\d+)/.exec(u)
        const start = m ? Number(m[1]) : 1
        const idx = Math.floor((start - 1) / 24)
        const results = pages[idx] ?? []
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

  it('不足 24 个可渲染项也全部上屏（流式，不阻塞）', async () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ id: 'wm' + i, title: 'Layer ' + i, thumbnail: null, numViews: 100 - i }))
    stubGalleryFetch([items], items.slice(0, 8).map((x) => x.id))
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Layer 0')).toBeInTheDocument(), { timeout: 8000 })
    await waitFor(() => expect(screen.getAllByText(/^Layer /)).toHaveLength(8), { timeout: 8000 })
  })

  it('第一页不足 24 时自动翻页，到底后显示已到底部', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => ({ id: 'p1-' + i, title: 'Hit ' + i, thumbnail: null, numViews: 100 - i }))
    const page2 = Array.from({ length: 24 }, (_, i) => ({ id: 'p2-' + i, title: 'Miss ' + i, thumbnail: null, numViews: 1 }))
    stubGalleryFetch([page1, page2], page1.slice(0, 8).map((x) => x.id))
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Hit 0')).toBeInTheDocument(), { timeout: 8000 })
    await waitFor(() => expect(screen.getByText('已到底部')).toBeInTheDocument(), { timeout: 10000 })
    expect(screen.queryByText(/^Miss /)).not.toBeInTheDocument()
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

  it('partial 保真度显示部分支持角标', async () => {
    const webmapPartial = {
      baseMap: { baseMapLayers: [{ title: 'Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }] },
      operationalLayers: [{ id: 'f', title: 'Feat', url: 'https://x/FeatureServer/0', layerType: 'ArcGISFeatureLayer' }],
    }
    stubGalleryFetch([[{ id: 'wm1', title: 'Partial', thumbnail: null, numViews: 5 }]], ['wm1'], webmapPartial)
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Partial')).toBeInTheDocument(), { timeout: 8000 })
    expect(screen.getAllByText('部分支持').length).toBeGreaterThan(0)
  })

  it('添加时跳过不支持图层并 toast 提示', async () => {
    const webmapMix = {
      baseMap: { baseMapLayers: [{ title: 'Imagery', url: 'https://x/MapServer', layerType: 'ArcGISTiledMapServiceLayer' }] },
      operationalLayers: [{ id: 'vt', title: 'Streets VT', url: '', layerType: 'VectorTileLayer' }],
    }
    stubGalleryFetch([[{ id: 'wm1', title: 'Mixed', thumbnail: null, numViews: 5 }]], ['wm1'], webmapMix)
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getAllByText('Mixed').length).toBeGreaterThan(0), { timeout: 8000 })
    fireEvent.click(screen.getAllByRole('button', { name: /Mixed/ })[0])
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/已添加，但部分图层不支持/), { timeout: 8000 })
  })
})


describe('LayerPanel 边界与错误路径', () => {
  beforeEach(() => {
    useAppStore.setState({ added: [], collapsed: false, collapsedRight: false, layerErrors: {} })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('webmap data 拉取失败 → 卡片被过滤且不报错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return { ok: true, json: async () => ({ results: [{ id: 'wm1', title: 'Fail', thumbnail: null, numViews: 1 }], nextStart: null, total: 1 }) }
        }
        if (u.includes('/sharing/rest/content/items/')) throw new Error('network down')
        return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.queryByText('Fail')).not.toBeInTheDocument(), { timeout: 8000 })
  })

  it('动态 MapServer（无缓存瓦片）被评估器过滤', async () => {
    const wmDyn = {
      baseMap: { baseMapLayers: [] },
      operationalLayers: [{ id: 'dyn', title: 'Dynamic', url: 'https://dyn/MapServer', layerType: 'ArcGISMapServiceLayer' }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return { ok: true, json: async () => ({ results: [{ id: 'wm1', title: 'Dynamic', thumbnail: null, numViews: 1 }], nextStart: null, total: 1 }) }
        }
        if (u.includes('/sharing/rest/content/items/')) return { ok: true, json: async () => wmDyn }
        // detectMapService：无 tileInfo → tiled=false（动态服务）
        return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 } }) }
      })
    )
    render(<LayerPanel />)
    await waitFor(() => expect(screen.queryByText('Dynamic')).not.toBeInTheDocument(), { timeout: 8000 })
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

  it('添加图层失败 → toast 提示', async () => {
    let dataCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('/sharing/rest/search')) {
          return { ok: true, json: async () => ({ results: [{ id: 'wm1', title: 'Broken', thumbnail: null, numViews: 1 }], nextStart: null, total: 1 }) }
        }
        if (u.includes('/sharing/rest/content/items/')) {
          dataCalls++
          // 预取成功（卡片渲染）；点击添加时的二次拉取失败 → toast
          if (dataCalls === 1) return { ok: true, json: async () => webmapData }
          throw new Error('boom')
        }
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
    await waitFor(() => expect(screen.getAllByText(/^P2 /)).toHaveLength(24), { timeout: 10000 })
  }, 20000)

  it('已添加图层带缩略图时渲染 img', () => {
    useAppStore.getState().addLayer({ id: 't1', title: 'ThumbLayer', thumb: 'https://x/t.png', kind: 'fallback' })
    render(<LayerPanel />)
    const img = screen.getByAltText('ThumbLayer') as HTMLImageElement
    expect(img.className).toBe('ac-thumb')
  })

  it('画廊卡片缩略图加载失败时隐藏', async () => {
    stubGalleryFetch([[{ id: 'wm1', title: 'Thumb', thumbnail: 't.png', numViews: 1 }]], ['wm1'])
    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByAltText('Thumb')).toBeInTheDocument(), { timeout: 8000 })
    const img = screen.getAllByAltText('Thumb')[0] as HTMLImageElement
    fireEvent.error(img)
    expect(img.style.display).toBe('none')
  })
})

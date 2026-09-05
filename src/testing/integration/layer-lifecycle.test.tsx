import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// 必须最先导入：注册 Cesium/MapLibre mock，保证 App 模块图加载前生效
import '../mocks/cesium'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import App from '../../App'
import { useAppStore } from '../../app/store'
import { getCesiumMock, resetCesiumMocks } from '../mocks/cesium'

const cesiumMock = getCesiumMock()

const webmapData = {
  baseMap: {
    baseMapLayers: [
      {
        title: 'Imagery',
        url: 'https://x/World_Imagery/MapServer',
        layerType: 'ArcGISTiledMapServiceLayer',
      },
    ],
  },
  operationalLayers: [],
}

const freshEffects = {
  atmosphere: false,
  stars: true,
  sunMoon: false,
  fog: false,
  dayNight: false,
  terrainExaggeration: 1,
  globeTranslucency: false,
  translucencyAlpha: 0.6,
  autoRotate: false,
  sunGlow: 2,
  atmosphereRing: true,
}

function stubSearchFetch(opts: { data: 'ok' | 'throw' | 'error' }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/sharing/rest/search')) {
        const q = new URL(u, 'http://localhost').searchParams.get('q') ?? ''
        if (!q.includes('Web Map')) {
          return { ok: true, json: async () => ({ results: [], nextStart: null, total: 0 }) }
        }
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                id: 'wm1',
                title: 'Test Imagery',
                thumbnail: null,
                numViews: 100,
                type: 'Web Map',
                contentStatus: 'public_authoritative',
                groupDesignations: 'livingatlas',
              },
            ],
            nextStart: null,
            total: 1,
          }),
        }
      }
      if (u.includes('/sharing/rest/content/items/wm1/data')) {
        if (opts.data === 'throw') throw new Error('boom')
        if (opts.data === 'error') return { ok: true, json: async () => ({ error: { code: 403 } }) }
        return { ok: true, json: async () => webmapData }
      }
      // detectMapService：tiled 服务元数据
      if (u.includes('World_Imagery/MapServer?f=json')) {
        return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) }
      }
      return { ok: true, json: async () => ({}) }
    })
  )
}

function viewer() {
  return cesiumMock.viewers[cesiumMock.viewers.length - 1]
}

describe('行为链路：搜索 → 添加 → 渲染 → 移除', () => {
  beforeEach(() => {
    resetCesiumMocks()
    localStorage.clear()
    useAppStore.setState({
      theme: 'dark',
      added: [],
      collapsed: false,
      collapsedRight: false,
      layerErrors: {},
      effects: freshEffects,
      userHome: null,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('搜索 WebMap → 点添加：卡片变已添加、store 记录、Cesium 收到影像图层', async () => {
    stubSearchFetch({ data: 'ok' })
    render(<App />)

    await waitFor(() => expect(screen.getByText('Test Imagery')).toBeInTheDocument(), { timeout: 8000 })
    // 底图常驻（影像 + 矢量标注）先就位
    await waitFor(() => expect(viewer().imageryLayers.length).toBe(2), { timeout: 8000 })

    fireEvent.click(screen.getByRole('button', { name: '添加 Test Imagery' }))

    await waitFor(() => expect(useAppStore.getState().added.some((l) => l.id === 'wm1')).toBe(true), { timeout: 8000 })
    expect(useAppStore.getState().added[0]).toMatchObject({
      id: 'wm1',
      title: 'Test Imagery',
      kind: 'webmap',
    })
    // 卡片按钮切换到“已添加”且禁用
    expect(screen.getByRole('button', { name: '已添加 Test Imagery' })).toBeDisabled()
    // 已添加列表出现缩略卡（画廊卡 + 已添加卡两张图）
    await waitFor(() => expect(screen.getAllByAltText('Test Imagery').length).toBe(2), { timeout: 8000 })
    // Cesium 收到 webmap 底图图层：影像 + 标注 + webmap 1 层
    await waitFor(() => expect(viewer().imageryLayers.length).toBe(3), { timeout: 8000 })
  }, 20000)

  it('添加失败：toast 提示，store 不变，Cesium 无新增图层', async () => {
    // 预置预检缓存为 ok，避免预检先消耗同一个失败端点（添加时才失败）
    localStorage.setItem(
      'earth-viewer:preflight',
      JSON.stringify({ wm1: { s: 'ok', t: Date.now() } })
    )
    stubSearchFetch({ data: 'throw' })
    render(<App />)

    await waitFor(() => expect(screen.getByText('Test Imagery')).toBeInTheDocument(), { timeout: 8000 })
    await waitFor(() => expect(viewer().imageryLayers.length).toBe(2), { timeout: 8000 })

    fireEvent.click(screen.getByRole('button', { name: '添加 Test Imagery' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/添加失败/), { timeout: 8000 })
    expect(useAppStore.getState().added).toHaveLength(0)
    expect(viewer().imageryLayers.length).toBe(2)
  }, 20000)

  it('预检 403：卡片自动隐藏，无法添加', async () => {
    stubSearchFetch({ data: 'error' })
    render(<App />)

    await waitFor(() => expect(screen.getByText('Test Imagery')).toBeInTheDocument(), { timeout: 8000 })
    await waitFor(() => expect(screen.queryByText('Test Imagery')).not.toBeInTheDocument(), { timeout: 8000 })
    expect(screen.queryByRole('button', { name: /添加/ })).not.toBeInTheDocument()
    expect(useAppStore.getState().added).toHaveLength(0)
  }, 20000)

  it('移除图层：store 清空，Cesium 移除 webmap 图层', async () => {
    stubSearchFetch({ data: 'ok' })
    render(<App />)

    await waitFor(() => expect(screen.getByText('Test Imagery')).toBeInTheDocument(), { timeout: 8000 })
    fireEvent.click(screen.getByRole('button', { name: '添加 Test Imagery' }))
    await waitFor(() => expect(useAppStore.getState().added.some((l) => l.id === 'wm1')).toBe(true), { timeout: 8000 })
    await waitFor(() => expect(viewer().imageryLayers.length).toBe(3), { timeout: 8000 })

    fireEvent.click(screen.getByTitle('移除图层'))

    await waitFor(() => expect(useAppStore.getState().added).toHaveLength(0), { timeout: 8000 })
    // webmap 图层被移除，回到仅底图
    await waitFor(() => expect(viewer().imageryLayers.length).toBe(2), { timeout: 8000 })
  }, 20000)
})

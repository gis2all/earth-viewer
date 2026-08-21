import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
  afterEach(() => vi.unstubAllGlobals())

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LayerPanel } from './LayerPanel'
import { useAppStore } from './store'

const LOAD_ERROR_ZH = '\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc / \u4ee3\u7406'
const UNSUPPORTED_ZH = '\u6682\u4e0d\u652f\u6301\u76f4\u63a5\u6dfb\u52a0\uff1aBroken'
const LOAD_ERROR_EN = 'Failed to load. Check your network or proxy.'
const UNSUPPORTED_EN = 'Direct add is not supported: Broken'

function actionFromCard(cardId: string, action: string): HTMLElement {
  const element = screen.getByTestId('gallery-card-' + cardId).querySelector<HTMLElement>(
    '[data-layer-action="' + action + '"]'
  )
  if (!element) throw new Error('Missing ' + action + ' action for gallery card ' + cardId)
  return element
}

describe('LayerPanel i18n', () => {
  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({
      locale: 'zh-CN',
      added: [],
      collapsed: false,
      collapsedRight: false,
      layerErrors: {},
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('retranslates a visible load error when the locale changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('boom')
    }))

    render(<LayerPanel />)
    await waitFor(
      () => expect(screen.getByTestId('layer-load-error')).toHaveTextContent(LOAD_ERROR_ZH),
      { timeout: 8000 }
    )

    act(() => useAppStore.setState({ locale: 'en' }))

    expect(screen.getByTestId('layer-load-error')).toHaveTextContent(LOAD_ERROR_EN)
  })

  it('retranslates a visible toast when the locale changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const value = String(url)
      if (value.includes('/sharing/rest/search')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ id: 'wm1', title: 'Broken', thumbnail: null, numViews: 1, type: 'Unsupported Type' }],
            nextStart: null,
            total: 1,
          }),
        }
      }
      if (value.includes('/sharing/rest/content/items/')) {
        return { ok: true, json: async () => ({ contentStatus: 'public_authoritative', groupDesignations: [] }) }
      }
      return { ok: true, json: async () => ({ spatialReference: { wkid: 3857 }, tileInfo: { lods: [] } }) }
    }))

    render(<LayerPanel />)
    await waitFor(() => expect(screen.getByText('Broken')).toBeInTheDocument(), { timeout: 8000 })
    fireEvent.click(actionFromCard('wm1', 'add'))
    await waitFor(
      () => expect(screen.getByTestId('layer-toast')).toHaveTextContent(UNSUPPORTED_ZH),
      { timeout: 8000 }
    )

    act(() => useAppStore.setState({ locale: 'en' }))

    expect(screen.getByTestId('layer-toast')).toHaveTextContent(UNSUPPORTED_EN)
  }, 15000)
})

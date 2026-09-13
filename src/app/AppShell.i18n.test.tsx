import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppShell } from './AppShell'
import { useAppStore } from './store'

vi.mock('./GlobeViewer', () => ({ GlobeViewer: () => <div data-testid="globe" /> }))
vi.mock('./LayerPanel', () => ({ LayerPanel: () => <div data-testid="layers" /> }))
vi.mock('./EffectsPanel', () => ({ EffectsPanel: () => <div data-testid="effects" /> }))

describe('AppShell i18n', () => {
  beforeEach(() => {
    useAppStore.setState({ locale: 'zh-CN', theme: 'dark', collapsed: false, collapsedRight: false })
  })

  it('switches UI copy and tooltips between Chinese and English', () => {
    render(<AppShell />)
    const languageButton = screen.getByTestId('language-toggle')
    expect(languageButton).toHaveAttribute('title', '切换为英文')
    expect(languageButton).toHaveTextContent('中')

    fireEvent.click(languageButton)

    expect(useAppStore.getState().locale).toBe('en')
    expect(languageButton).toHaveAttribute('title', 'Switch to Chinese')
    expect(languageButton).toHaveTextContent('EN')
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('title', 'Toggle theme')
    expect(screen.getByTestId('reset-view')).toHaveAttribute('title', 'Reset view')
  })
})

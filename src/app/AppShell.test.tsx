import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppShell } from './AppShell'
import { useAppStore } from '../state/store'

vi.mock('../globe/GlobeViewer', () => ({ GlobeViewer: () => <div data-testid="globe" /> }))
vi.mock('./LayerPanel', () => ({ LayerPanel: () => <div data-testid="layers" /> }))
vi.mock('./EffectsPanel', () => ({ EffectsPanel: () => <div data-testid="effects" /> }))

describe('AppShell', () => {
  beforeEach(() => {
    useAppStore.setState({ theme: 'dark', collapsed: false, collapsedRight: false })
    document.head.innerHTML = ''
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    link.href = '/favicon-dark.svg'
    document.head.appendChild(link)
  })

  it('渲染品牌与三面板', () => {
    render(<AppShell />)
    expect(screen.getByText('Earth Viewer')).toBeInTheDocument()
    expect(screen.getByTestId('globe')).toBeInTheDocument()
    expect(screen.getByTestId('layers')).toBeInTheDocument()
    expect(screen.getByTestId('effects')).toBeInTheDocument()
  })

  it('主题切换更新 favicon 与 store', () => {
    render(<AppShell />)
    fireEvent.click(screen.getByTitle('切换主题'))
    expect(useAppStore.getState().theme).toBe('light')
    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]') as HTMLLinkElement
    expect(link.href.endsWith('/favicon-light.svg')).toBe(true)
  })

  it('面板折叠时显示展开按钮，点击展开', () => {
    useAppStore.setState({ collapsed: true, collapsedRight: true })
    render(<AppShell />)
    fireEvent.click(screen.getByTitle('展开面板'))
    expect(useAppStore.getState().collapsed).toBe(false)
    fireEvent.click(screen.getByTitle('展开效果面板'))
    expect(useAppStore.getState().collapsedRight).toBe(false)
  })

  it('回正/复位按钮存在且可点击（未注册 viewer 不报错）', () => {
    render(<AppShell />)
    expect(screen.getByTitle('回正视角')).toBeInTheDocument()
    expect(screen.getByTitle('复位视角')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('复位视角'))
    fireEvent.click(screen.getByTitle('回正视角'))
  })
})

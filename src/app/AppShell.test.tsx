import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppShell } from './AppShell'
import { useAppStore } from './store'

vi.mock('./GlobeViewer', () => ({ GlobeViewer: () => <div data-testid="globe" /> }))
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
    fireEvent.click(screen.getByTestId('theme-toggle'))
    expect(useAppStore.getState().theme).toBe('light')
    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]') as HTMLLinkElement
    expect(link.href.endsWith('/favicon-light.svg')).toBe(true)
  })

  it('面板折叠时显示展开按钮，点击展开', () => {
    useAppStore.setState({ collapsed: true, collapsedRight: true })
    render(<AppShell />)
    expect(screen.getByTestId('expand-left-panel').querySelector('svg')).toHaveAttribute('width', '16')
    expect(screen.getByTestId('expand-right-panel').querySelector('svg')).toHaveAttribute('height', '16')
    fireEvent.click(screen.getByTestId('expand-left-panel'))
    expect(useAppStore.getState().collapsed).toBe(false)
    fireEvent.click(screen.getByTestId('expand-right-panel'))
    expect(useAppStore.getState().collapsedRight).toBe(false)
  })

  it('回正/复位按钮存在且可点击（未注册 viewer 不报错）', () => {
    render(<AppShell />)
    expect(screen.getByTestId('orient-view')).toBeInTheDocument()
    expect(screen.getByTestId('reset-view')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('reset-view'))
    fireEvent.click(screen.getByTestId('orient-view'))
  })

  it('回正/复位图标：回正为对角 L 对齐、复位为房子图标', () => {
    render(<AppShell />)
    const orientIcon = screen.getByTestId('orient-view').querySelector('svg')
    const resetIcon = screen.getByTestId('reset-view').querySelector('svg')
    expect(orientIcon).toHaveAttribute('width', '17')
    expect(orientIcon).toHaveAttribute('height', '17')
    expect(orientIcon?.querySelector('rect')).toBeNull()
    expect(orientIcon?.querySelectorAll('path')).toHaveLength(2)
    expect(orientIcon?.querySelectorAll('circle')).toHaveLength(1)
    expect(resetIcon).toHaveAttribute('width', '18')
    expect(resetIcon).toHaveAttribute('height', '18')
    expect(resetIcon?.querySelector('rect')).toBeNull()
    expect(resetIcon?.querySelectorAll('path')).toHaveLength(3)
  })

  it('显示 GitHub 导航链接并在新标签页打开', () => {
    render(<AppShell />)
    const githubLink = screen.getByTestId('github-link')
    expect(githubLink).toHaveAttribute('href', 'https://github.com/gis2all/earth-viewer')
    expect(githubLink).toHaveAttribute('target', '_blank')
    expect(githubLink).toHaveAttribute('rel', 'noreferrer')
  })

  it('主题、沉浸模式与 GitHub 图标使用 16px 绘制尺寸', () => {
    render(<AppShell />)
    const controls = [
      screen.getByTestId('theme-toggle'),
      screen.getByTestId('immersive-enter'),
      screen.getByTestId('github-link'),
    ]

    controls.forEach((control) => {
      expect(control.querySelector('svg')).toHaveAttribute('width', '16')
      expect(control.querySelector('svg')).toHaveAttribute('height', '16')
    })
  })

  it('进入沉浸模式后显示退出入口，并可恢复普通模式', () => {
    render(<AppShell />)
    const app = document.querySelector('.app')

    fireEvent.click(screen.getByTestId('immersive-enter'))
    expect(app).toHaveClass('immersive')
    expect(screen.getByTestId('immersive-exit')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('immersive-exit'))
    expect(app).not.toHaveClass('immersive')
    expect(screen.getByTestId('immersive-enter')).toBeInTheDocument()
  })

  it('沉浸模式支持 Esc 退出', () => {
    render(<AppShell />)
    const app = document.querySelector('.app')

    fireEvent.click(screen.getByTestId('immersive-enter'))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(app).not.toHaveClass('immersive')
  })
})

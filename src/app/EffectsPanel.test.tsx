import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EffectsPanel } from './EffectsPanel'
import { useAppStore } from '../state/store'

describe('EffectsPanel', () => {
  beforeEach(() => {
    useAppStore.setState({
      effects: {
        atmosphere: false,
        stars: true,
        sunMoon: false,
        fog: false,
        dayNight: false,
        terrainExaggeration: 1,
        globeTranslucency: false,
        translucencyAlpha: 0.6,
        autoRotate: false,
      },
    })
  })

  it('渲染 GIS 术语标签', () => {
    render(<EffectsPanel />)
    expect(screen.getByText('大气散射')).toBeInTheDocument()
    expect(screen.getByText('星空背景')).toBeInTheDocument()
    expect(screen.getByText('日月')).toBeInTheDocument()
    expect(screen.getByText('昼夜光照')).toBeInTheDocument()
    expect(screen.getByText('地形透明')).toBeInTheDocument()
    expect(screen.getByText('自动环绕')).toBeInTheDocument()
  })

  it('点击开关更新 store', () => {
    render(<EffectsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '大气散射' }))
    expect(useAppStore.getState().effects.atmosphere).toBe(true)
  })

  it('地形透明关闭时透明度滑杆隐藏，开启后显示', () => {
    render(<EffectsPanel />)
    expect(screen.queryByText('透明度')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '地形透明' }))
    expect(screen.getByText('透明度')).toBeInTheDocument()
  })
})

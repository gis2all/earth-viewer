import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EffectsPanel } from './EffectsPanel'
import { useAppStore } from './store'

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
        sunGlow: 2,
        atmosphereRing: true,
      },
    })
  })

  it('渲染所有可见效果控件', () => {
    render(<EffectsPanel />)
    expect(screen.getByTestId('effects-panel-toggle')).toBeInTheDocument()
    expect(document.querySelector('[data-effect="atmosphere"]')).toBeInTheDocument()
    expect(document.querySelector('[data-effect="stars"]')).toBeInTheDocument()
    expect(document.querySelector('[data-effect="sunMoon"]')).toBeInTheDocument()
    expect(document.querySelector('[data-effect="dayNight"]')).toBeInTheDocument()
    expect(document.querySelector('[data-effect="globeTranslucency"]')).toBeInTheDocument()
    expect(document.querySelector('[data-effect="terrainExaggeration"]')).toBeInTheDocument()
    expect(document.querySelector('[data-effect="autoRotate"]')).toBeInTheDocument()
  })

  it('点击开关更新 store', () => {
    render(<EffectsPanel />)
    fireEvent.click(document.querySelector('[data-effect="atmosphere"]') as HTMLElement)
    expect(useAppStore.getState().effects.atmosphere).toBe(true)
  })

  it('地形透明关闭时透明度滑杆隐藏，开启后显示', () => {
    render(<EffectsPanel />)
    expect(document.querySelector('[data-effect="translucencyAlpha"]')).not.toBeInTheDocument()
    fireEvent.click(document.querySelector('[data-effect="globeTranslucency"]') as HTMLElement)
    expect(document.querySelector('[data-effect="translucencyAlpha"]')).toBeInTheDocument()
  })
})

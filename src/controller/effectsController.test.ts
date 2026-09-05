import { describe, it, expect, vi } from 'vitest'
import {
  EffectsController,
  type EffectsControllerDeps,
  type EffectsSnapshot,
  type EffectsSurface,
} from './effectsController'

function snapshot(overrides: Partial<EffectsSnapshot> = {}): EffectsSnapshot {
  return {
    atmosphere: true,
    stars: true,
    sunMoon: false,
    fog: true,
    dayNight: false,
    terrainExaggeration: 2,
    globeTranslucency: true,
    translucencyAlpha: 0.4,
    sunGlow: 2,
    atmosphereRing: true,
    ...overrides,
  }
}

function setup(overrides: Partial<EffectsControllerDeps> = {}) {
  type MockedSurface = EffectsSurface & { [K in keyof EffectsSurface]: ReturnType<typeof vi.fn> }
  const surface = {
    setAtmosphere: vi.fn(),
    setBackgroundColor: vi.fn(),
    setSkyBox: vi.fn(),
    setSunMoon: vi.fn(),
    setFog: vi.fn(),
    setLighting: vi.fn(),
    setVerticalExaggeration: vi.fn(),
    setTranslucency: vi.fn(),
    setSunGlow: vi.fn(),
    setAtmosphereRing: vi.fn(),
    requestFrame: vi.fn(),
  } as unknown as MockedSurface
  const theme = vi.fn<() => 'dark' | 'light'>(() => 'dark')
  const effects = vi.fn(() => snapshot())
  const onChanged = vi.fn()
  const ctrl = new EffectsController({ surface, theme, effects, onChanged, ...overrides })
  return { ctrl, surface, theme, effects, onChanged }
}

describe('EffectsController（W3.3）', () => {
  it('sync() 把效果快照映射到渲染表面并唤醒/请求一帧', () => {
    const { ctrl, surface, onChanged } = setup()
    ctrl.sync()
    expect(surface.setAtmosphere).toHaveBeenCalledWith(true)
    expect(surface.setBackgroundColor).toHaveBeenCalledWith('#05070d')
    expect(surface.setSkyBox).toHaveBeenCalledWith(true)
    expect(surface.setSunMoon).toHaveBeenCalledWith(false)
    expect(surface.setFog).toHaveBeenCalledWith(true)
    expect(surface.setLighting).toHaveBeenCalledWith(false)
    expect(surface.setVerticalExaggeration).toHaveBeenCalledWith(2)
    expect(surface.setTranslucency).toHaveBeenCalledWith(true, 0.4)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(surface.requestFrame).toHaveBeenCalledTimes(1)
  })

  it('浅色主题 → 白底、无星空', () => {
    const { ctrl, surface, theme } = setup()
    theme.mockReturnValue('light')
    ctrl.sync()
    expect(surface.setBackgroundColor).toHaveBeenCalledWith('#ffffff')
    expect(surface.setSkyBox).toHaveBeenCalledWith(false)
  })

  it('深色主题下星空开关跟随 stars', () => {
    const { ctrl, surface } = setup()
    ctrl.sync()
    expect(surface.setSkyBox).toHaveBeenCalledWith(true)
  })

  it('dispose 后 sync 为 no-op', () => {
    const { ctrl, surface, onChanged } = setup()
    ctrl.dispose()
    ctrl.sync()
    expect(surface.setAtmosphere).not.toHaveBeenCalled()
    expect(surface.requestFrame).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from './store'

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
}

describe('store', () => {
  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({
      theme: 'dark',
      collapsed: false,
      collapsedRight: false,
      added: [],
      layerErrors: {},
      effects: freshEffects,
    })
  })

  it('toggleTheme 深浅切换', () => {
    expect(useAppStore.getState().theme).toBe('dark')
    useAppStore.getState().toggleTheme()
    expect(useAppStore.getState().theme).toBe('light')
    useAppStore.getState().toggleTheme()
    expect(useAppStore.getState().theme).toBe('dark')
  })

  it('toggleCollapsed / toggleCollapsedRight', () => {
    useAppStore.getState().toggleCollapsed()
    expect(useAppStore.getState().collapsed).toBe(true)
    useAppStore.getState().toggleCollapsedRight()
    expect(useAppStore.getState().collapsedRight).toBe(true)
  })

  it('addLayer 去重：相同 id 不重复添加', () => {
    const l = { id: 'a', title: 'A', kind: 'webmap' as const }
    useAppStore.getState().addLayer(l)
    useAppStore.getState().addLayer(l)
    expect(useAppStore.getState().added).toHaveLength(1)
  })

  it('removeLayer 只移除指定 id', () => {
    useAppStore.getState().addLayer({ id: 'a', title: 'A', kind: 'webmap' })
    useAppStore.getState().addLayer({ id: 'b', title: 'B', kind: 'webmap' })
    useAppStore.getState().removeLayer('a')
    expect(useAppStore.getState().added.map((x) => x.id)).toEqual(['b'])
  })

  it('setLayerError / clearLayerError（含不存在的 id）', () => {
    useAppStore.getState().setLayerError('a', '加载失败')
    expect(useAppStore.getState().layerErrors).toEqual({ a: '加载失败' })
    useAppStore.getState().clearLayerError('a')
    expect(useAppStore.getState().layerErrors).toEqual({})
    useAppStore.getState().clearLayerError('nope')
    expect(useAppStore.getState().layerErrors).toEqual({})
  })

  it('setEffect 只更新指定字段', () => {
    useAppStore.getState().setEffect('fog', true)
    expect(useAppStore.getState().effects.fog).toBe(true)
    expect(useAppStore.getState().effects.stars).toBe(true)
    useAppStore.getState().setEffect('translucencyAlpha', 0.8)
    expect(useAppStore.getState().effects.translucencyAlpha).toBe(0.8)
  })
})

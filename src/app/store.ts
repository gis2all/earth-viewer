import { create } from 'zustand'
import type { UserHome } from '../domain/types'
import { persist } from 'zustand/middleware'

export type Theme = 'dark' | 'light'

export interface AddedLayer {
  id: string
  title: string
  thumb?: string
  itemId?: string
  webmap?: Record<string, unknown>
  kind: 'webmap' | 'fallback'
}

export interface Effects {
  atmosphere: boolean
  stars: boolean
  sunMoon: boolean
  fog: boolean
  dayNight: boolean
  terrainExaggeration: number
  globeTranslucency: boolean
  translucencyAlpha: number
  autoRotate: boolean
  /** 是否显示区划/参考网格层（如 NWS zones） */
  showReferenceLayers?: boolean
}

interface AppState {
  theme: Theme
  toggleTheme: () => void
  collapsed: boolean
  toggleCollapsed: () => void
  collapsedRight: boolean
  toggleCollapsedRight: () => void
  added: AddedLayer[]
  addLayer: (l: AddedLayer) => void
  removeLayer: (id: string) => void
  /** 图层加载失败信息：layerId -> 错误描述（会话级，不持久化） */
  layerErrors: Record<string, string>
  setLayerError: (id: string, msg: string) => void
  clearLayerError: (id: string) => void
  effects: Effects
  setEffect: <K extends keyof Effects>(key: K, value: Effects[K]) => void
  /** 用户大概位置（内存态；持久化由 geo.ts 的 localStorage 负责） */
  userHome: UserHome | null
  setUserHome: (h: UserHome | null) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
  theme: 'dark',
  toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
  collapsed: false,
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  collapsedRight: false,
  toggleCollapsedRight: () => set((s) => ({ collapsedRight: !s.collapsedRight })),
  added: [],
  addLayer: (l) =>
    set((s) => (s.added.some((x) => x.id === l.id) ? s : { added: [...s.added, l] })),
  removeLayer: (id) => set((s) => ({ added: s.added.filter((x) => x.id !== id) })),
  layerErrors: {},
  setLayerError: (id, msg) => set((s) => ({ layerErrors: { ...s.layerErrors, [id]: msg } })),
  clearLayerError: (id) =>
    set((s) => {
      if (!(id in s.layerErrors)) return s
      const next = { ...s.layerErrors }
      delete next[id]
      return { layerErrors: next }
    }),
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
    showReferenceLayers: true,
  },
    setEffect: (key, value) => set((s) => ({ effects: { ...s.effects, [key]: value } })),
    userHome: null,
    setUserHome: (h) => set({ userHome: h }),
    }),
    {
      name: 'earth-viewer',
      // 只持久化用户状态，不持久化函数；刷新后恢复主题/面板/已添加图层/效果
      partialize: (s) => ({
        theme: s.theme,
        collapsed: s.collapsed,
        collapsedRight: s.collapsedRight,
        added: s.added,
        effects: s.effects,
      }),
    }
  )
)

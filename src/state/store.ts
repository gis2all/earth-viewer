import { create } from 'zustand'

export type Theme = 'dark' | 'light'

interface AppState {
  theme: Theme
  toggleTheme: () => void
  collapsed: boolean
  toggleCollapsed: () => void
  activeBase: string | null
  activeOverlays: string[]
  setBase: (id: string) => void
  toggleOverlay: (id: string) => void
  time: number
  setTime: (t: number) => void
}

export const useAppStore = create<AppState>((set) => ({
  theme: 'dark',
  toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
  collapsed: false,
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  activeBase: 'terrain',
  activeOverlays: [],
  setBase: (id) => set({ activeBase: id }),
  toggleOverlay: (id) =>
    set((s) => ({
      activeOverlays: s.activeOverlays.includes(id)
        ? s.activeOverlays.filter((x) => x !== id)
        : [...s.activeOverlays, id],
    })),
  time: 720,
  setTime: (t) => set({ time: t }),
}))
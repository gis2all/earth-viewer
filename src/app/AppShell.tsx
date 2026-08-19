import { GlobeViewer } from '../globe/GlobeViewer'
import { LayerPanel } from './LayerPanel'
import { Timeline } from './Timeline'
import { useAppStore } from '../state/store'

export function AppShell() {
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const collapsed = useAppStore((s) => s.collapsed)
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsed)

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">EV</span>
          <span className="brand-name">EarthViz</span>
        </div>
        <div className="spacer" />
        <button className="icon-btn" onClick={toggleTheme} title="切换白天 / 深色">
          {theme === 'dark' ? (
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M13.5 9.2A5.6 5.6 0 1 1 6.8 2.5a4.6 4.6 0 0 0 6.7 6.7z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
            </svg>
          )}
        </button>
      </header>
      <div className="workspace">
        <LayerPanel />
        <main className="globe-wrap">
          {collapsed && (
            <button className="expand-btn" onClick={toggleCollapsed} title="展开面板">›</button>
          )}
          <GlobeViewer />
          <Timeline />
        </main>
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { GlobeViewer } from '../globe/GlobeViewer'
import { LayerPanel } from './LayerPanel'
import { EffectsPanel } from './EffectsPanel'
import { useAppStore } from '../state/store'
import { resetView, orientView } from '../globe/cameraApi'

export function AppShell() {
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)

  // favicon 跟随主题，与顶栏品牌图标保持一致（深色=白球黑切，浅色=黑球白切）
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
    if (link) link.href = theme === 'dark' ? '/favicon-dark.svg' : '/favicon-light.svg'
  }, [theme])
  const collapsed = useAppStore((s) => s.collapsed)
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsed)
  const collapsedRight = useAppStore((s) => s.collapsedRight)
  const toggleCollapsedRight = useAppStore((s) => s.toggleCollapsedRight)

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <svg viewBox="0 0 28 28" width="19" height="19" aria-hidden="true">
              <defs>
                <clipPath id="brand-mark-clip">
                  <circle cx="14" cy="14" r="11" />
                </clipPath>
              </defs>
              <circle cx="14" cy="14" r="11" fill={theme === 'dark' ? '#ffffff' : '#000000'} />
              <g clipPath="url(#brand-mark-clip)">
                <path d="M0 24 28 -2" stroke={theme === 'dark' ? '#000000' : '#ffffff'} strokeWidth="2.6" />
                <path d="M4 28 32 0" stroke={theme === 'dark' ? '#000000' : '#ffffff'} strokeWidth="1" opacity="0.5" />
                <circle cx="14" cy="14" r="4.4" fill={theme === 'dark' ? '#000000' : '#ffffff'} />
              </g>
            </svg>
          </span>
          <span className="brand-name">Earth Viewer</span>
        </div>
        <div className="spacer" />
        <button className="icon-btn" onClick={orientView} title="回正视角">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6" />
            <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
            <path d="M8 5V3M8 13V11M5 8H3M13 8H11" />
          </svg>
        </button>
        <button className="icon-btn" onClick={resetView} title="复位视角">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6" />
            <ellipse cx="8" cy="8" rx="2.4" ry="6" />
            <path d="M2.5 8H13.5" />
          </svg>
        </button>
        <span className="hdr-divider" />
        <button className="icon-btn" onClick={toggleTheme} title="切换主题">
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
          {collapsedRight && (
            <button className="expand-btn expand-right" onClick={toggleCollapsedRight} title="展开效果面板">‹</button>
          )}
          <GlobeViewer />
        </main>
        <EffectsPanel />
      </div>
    </div>
  )
}

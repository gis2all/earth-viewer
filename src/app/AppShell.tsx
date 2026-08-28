import { useEffect, useState } from 'react'
import { GlobeViewer } from '../globe/GlobeViewer'
import { LayerPanel } from './LayerPanel'
import { EffectsPanel } from './EffectsPanel'
import { useAppStore } from '../state/store'
import { resetView, orientView } from '../globe/facade/cameraApi'

function PanelChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d={direction === 'right' ? 'm6 4 4 4-4 4' : 'm10 4-4 4 4 4'} /></svg>
}

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
  const [immersive, setImmersive] = useState(false)

  useEffect(() => {
    if (!immersive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImmersive(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [immersive])

  return (
    <div className={'app' + (immersive ? ' immersive' : '')}>
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
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="1" y="1" width="14" height="14" />
            <path d="M8 10V6M6.7 7.3 8 6l1.3 1.3" />
          </svg>
        </button>
        <button className="icon-btn" onClick={resetView} title="复位视角">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="1" y="1" width="14" height="14" />
            <path d="M5.6 8a2.4 2.4 0 1 0 4.2-1.6" />
            <path d="m9.8 5.1.1 1.8-1.8-.1" />
          </svg>
        </button>
        <span className="hdr-divider" />
        <button className="icon-btn" onClick={toggleTheme} title="切换主题">
          {theme === 'dark' ? (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M13.5 9.2A5.6 5.6 0 1 1 6.8 2.5a4.6 4.6 0 0 0 6.7 6.7z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
            </svg>
          )}
        </button>
        <button className="icon-btn" onClick={() => setImmersive(true)} title="进入沉浸模式" aria-label="进入沉浸模式">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
            <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
          </svg>
        </button>
        <a
          className="icon-btn"
          href="https://github.com/gis2all/earth-viewer"
          target="_blank"
          rel="noreferrer"
          title="GitHub"
          aria-label="GitHub"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.07c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
        </a>
      </header>
      <div className="workspace">
          <LayerPanel />
          <main className="globe-wrap">
          {!immersive && collapsed && (
            <button className="expand-btn" onClick={toggleCollapsed} title="展开面板"><PanelChevronIcon direction="right" /></button>
          )}
          {!immersive && collapsedRight && (
            <button className="expand-btn expand-right" onClick={toggleCollapsedRight} title="展开效果面板"><PanelChevronIcon direction="left" /></button>
          )}
          {immersive && (
            <button className="immersive-exit icon-btn" onClick={() => setImmersive(false)} title="退出沉浸模式" aria-label="退出沉浸模式">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
                <path d="M6 2v4H2M10 2v4h4M14 10h-4v4M6 14v-4H2" />
              </svg>
            </button>
          )}
          <GlobeViewer />
        </main>
        <EffectsPanel />
      </div>
    </div>
  )
}

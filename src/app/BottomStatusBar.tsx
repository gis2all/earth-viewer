import type { ReactNode } from 'react'
import { useAppStore } from './store'

/** 底部状态栏：左段信息区（数据署名 + 经纬度 + 视角高度），右段品牌区。 */
export interface BottomStatus {
  lon: number
  lat: number
  height: number
}

function formatLon(lon: number): string {
  const v = Math.abs(lon)
  return v.toFixed(2) + String.fromCharCode(176) + (lon >= 0 ? 'E' : 'W')
}

function formatLat(lat: number): string {
  const v = Math.abs(lat)
  return v.toFixed(2) + String.fromCharCode(176) + (lat >= 0 ? 'N' : 'S')
}

function formatHeight(h: number): string {
  // 输入为米；统一按 km 显示（2 位小数），如 22000.31 km
  return (h / 1000).toFixed(2) + ' km'
}

function BrandLogo({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <svg viewBox="0 0 28 28" width="14" height="14" aria-hidden="true">
      <defs>
        <clipPath id="bs-brand-clip">
          <circle cx="14" cy="14" r="11" />
        </clipPath>
      </defs>
      <circle cx="14" cy="14" r="11" fill={theme === 'dark' ? '#ffffff' : '#000000'} />
      <g clipPath="url(#bs-brand-clip)">
        <path d="M0 24 28 -2" stroke={theme === 'dark' ? '#000000' : '#ffffff'} strokeWidth="2.6" />
        <path d="M4 28 32 0" stroke={theme === 'dark' ? '#000000' : '#ffffff'} strokeWidth="1" opacity="0.5" />
        <circle cx="14" cy="14" r="4.4" fill={theme === 'dark' ? '#000000' : '#ffffff'} />
      </g>
    </svg>
  )
}

export function BottomStatusBar({ status, theme }: { status: BottomStatus | null; theme: 'dark' | 'light' }) {
  // 直接从 store 订阅面板折叠状态（zustand 驱动重渲染），确保面板开合时宽度即时跟随
  const collapsed = useAppStore((s) => s.collapsed)
  const collapsedRight = useAppStore((s) => s.collapsedRight)
  // 左右面板展开宽度（与 theme.css .panel / .panel-right 的 clamp 保持一致）
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const leftPanel = Math.max(320, Math.min(423, 0.2 * vw))
  const rightPanel = Math.max(240, Math.min(304, 0.14 * vw))
  const barStyle = {
    left: collapsed ? 0 : leftPanel,
    right: collapsedRight ? 0 : rightPanel,
  }
  const items: ReactNode[] = []
  if (status) {
    items.push(
      <span className="bc-item" key="pos">
        位置: {formatLon(status.lon)}, {formatLat(status.lat)}
      </span>
    )
    items.push(<span className="bc-sep" key="sep1" aria-hidden="true" />)
    items.push(<span className="bc-item" key="height">相机高度: {formatHeight(status.height)}</span>)
  }

  return (
    <div className="bottom-bar" style={barStyle} aria-hidden="true">
      <div className="bc-center">
        {items}
        <span className="bc-sep" aria-hidden="true" />
        <span className="bc-powered">Powered by</span>
        <span className="bc-brand">
          <BrandLogo theme={theme} />
          <span className="bc-brand-name">gis2all</span>
        </span>
      </div>
    </div>
  )
}

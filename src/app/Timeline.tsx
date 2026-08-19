import { useAppStore } from '../state/store'

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
}

export function Timeline() {
  const time = useAppStore((s) => s.time)
  const setTime = useAppStore((s) => s.setTime)
  const activeOverlays = useAppStore((s) => s.activeOverlays)
  const temporal = activeOverlays.includes('weather') || activeOverlays.includes('quakes')

  if (!temporal) return null

  return (
    <div className="timeline">
      <button className="tl-play" title="播放 / 暂停">▶</button>
      <span className="tl-time">{fmt(time)}</span>
      <input
        type="range"
        min={0}
        max={1440}
        step={10}
        value={time}
        onChange={(e) => setTime(Number(e.target.value))}
        aria-label="时间"
      />
      <span className="tl-hint">过去 24 小时</span>
    </div>
  )
}
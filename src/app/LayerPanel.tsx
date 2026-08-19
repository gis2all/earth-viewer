import { useAppStore } from '../state/store'
import { catalog } from '../layers/catalog'
import { LayerThumb } from '../layers/thumbs'

export function LayerPanel() {
  const collapsed = useAppStore((s) => s.collapsed)
  const activeBase = useAppStore((s) => s.activeBase)
  const activeOverlays = useAppStore((s) => s.activeOverlays)
  const setBase = useAppStore((s) => s.setBase)
  const toggleOverlay = useAppStore((s) => s.toggleOverlay)
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsed)

  const bases = catalog.filter((l) => l.category === 'base')
  const overlays = catalog.filter((l) => l.category === 'overlay')

  return (
    <aside className={'panel' + (collapsed ? ' collapsed' : '')}>
      <button className="fold" onClick={toggleCollapsed} title={collapsed ? '展开' : '收起'}>
        {collapsed ? '›' : '‹'}
      </button>
      <div className="panel-inner">
        <section className="group">
          <div className="group-head"><span className="group-name">基底 · 单选</span></div>
          <div className="boards">
            {bases.map((l) => (
              <button
                key={l.id}
                className={'board' + (activeBase === l.id ? ' on' : '')}
                onClick={() => setBase(l.id)}
                title={l.desc}
              >
                <LayerThumb kind={l.thumb} />
                <span className="board-name">{l.name}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="group">
          <div className="group-head"><span className="group-name">叠加 · 多选</span></div>
          <div className="boards">
            {overlays.map((l) => (
              <button
                key={l.id}
                className={'board' + (activeOverlays.includes(l.id) ? ' on' : '')}
                onClick={() => toggleOverlay(l.id)}
                title={l.desc}
              >
                <LayerThumb kind={l.thumb} />
                <span className="board-name">{l.name}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </aside>
  )
}
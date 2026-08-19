import { useAppStore } from '../state/store'
import { catalog, GROUP_LABELS, THEMATIC_GROUPS } from '../layers/catalog'
import { LayerThumb } from '../layers/thumbs'

export function LayerPanel() {
  const collapsed = useAppStore((s) => s.collapsed)
  const activeBase = useAppStore((s) => s.activeBase)
  const activeOverlays = useAppStore((s) => s.activeOverlays)
  const setBase = useAppStore((s) => s.setBase)
  const toggleOverlay = useAppStore((s) => s.toggleOverlay)
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsed)

  const bases = catalog.filter((l) => l.category === 'base')

  const renderBoards = (
    layers: typeof catalog,
    on: (l: (typeof catalog)[number]) => boolean,
    onClick: (l: (typeof catalog)[number]) => void
  ) => (
    <div className="boards">
      {layers.map((l) => (
        <button
          key={l.id}
          className={'board' + (on(l) ? ' on' : '')}
          onClick={() => onClick(l)}
          title={l.desc}
        >
          <LayerThumb kind={l.thumb} />
          <span className="board-name">{l.name}</span>
        </button>
      ))}
    </div>
  )

  return (
    <aside className={'panel' + (collapsed ? ' collapsed' : '')}>
      <button className="fold" onClick={toggleCollapsed} title={collapsed ? '展开' : '收起'}>
        {collapsed ? '›' : '‹'}
      </button>
      <div className="panel-inner">
        <section className="group">
          <div className="group-head"><span className="group-name">{GROUP_LABELS.base}</span></div>
          {renderBoards(bases, (l) => activeBase === l.id, (l) => setBase(l.id))}
        </section>
        {THEMATIC_GROUPS.map((g) => {
          const layers = catalog.filter((l) => l.group === g)
          if (layers.length === 0) return null
          return (
            <section className="group" key={g}>
              <div className="group-head"><span className="group-name">{GROUP_LABELS[g]}</span></div>
              {renderBoards(layers, (l) => activeOverlays.includes(l.id), (l) => toggleOverlay(l.id))}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

import { useAppStore, type Effects } from '../state/store'

type Item =
  | { key: keyof Effects; label: string; kind: 'switch'; note?: string; disabled?: boolean }
  | {
      key: keyof Effects
      label: string
      kind: 'slider'
      min: number
      max: number
      step: number
      suffix: string
      precision?: number
      dependsOn?: keyof Effects
    }

const GROUPS: { name: string; items: Item[] }[] = [
  {
    name: '环境',
    items: [
      { key: 'atmosphere', label: '大气散射', kind: 'switch' },
      { key: 'stars', label: '星空背景', kind: 'switch' },
      { key: 'sunMoon', label: '日月', kind: 'switch' },
      { key: 'fog', label: '雾效', kind: 'switch' },
      { key: 'dayNight', label: '昼夜光照', kind: 'switch' },
    ],
  },
  {
    name: '地形',
    items: [
      { key: 'globeTranslucency', label: '地形透明', kind: 'switch' },
      { key: 'translucencyAlpha', label: '透明度', kind: 'slider', min: 0.1, max: 1, step: 0.05, suffix: '', precision: 2, dependsOn: 'globeTranslucency' },
      { key: 'terrainExaggeration', label: '地形夸张', kind: 'slider', min: 1, max: 3, step: 0.1, suffix: 'X' },
    ],
  },
  {
    name: '视图',
    items: [
      { key: 'autoRotate', label: '自动环绕', kind: 'switch' },
      { key: 'showReferenceLayers', label: '区划网格', kind: 'switch', note: '显示区划/参考层描边' },
    ],
  },
]

export function EffectsPanel() {
  const collapsed = useAppStore((s) => s.collapsedRight)
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsedRight)
  const effects = useAppStore((s) => s.effects)
  const setEffect = useAppStore((s) => s.setEffect)

  return (
    <aside className={'panel panel-right' + (collapsed ? ' collapsed' : '')}>
      <div className="side-head">
        <span className="side-title">效果</span>
        <button className="fold" onClick={toggleCollapsed} title={collapsed ? '展开效果面板' : '收起效果面板'}>
          {collapsed ? '›' : '‹'}
        </button>
      </div>
      <div className="panel-inner">
        {GROUPS.map((g) => (
          <section className="group" key={g.name}>
            <div className="group-head">
              <span className="group-name">{g.name}</span>
            </div>
            <div className="fx-list">
              {g.items
                .filter((it) => !(it.kind === 'slider' && it.dependsOn && !effects[it.dependsOn]))
                .map((it) =>
                it.kind === 'switch' ? (
                  <div className="fx-row" key={it.key}>
                    <span className={'fx-label' + (it.disabled ? ' fx-off' : '')}>
                      {it.label}
                      {it.note ? <em className="fx-note">{it.note}</em> : null}
                    </span>
                    <button
                      className={'fx-sw' + (effects[it.key] ? ' on' : '')}
                      onClick={() => !it.disabled && setEffect(it.key, !effects[it.key])}
                      disabled={it.disabled}
                      aria-label={it.label}
                    />
                  </div>
                ) : (
                  <div className="fx-row" key={it.key}>
                    <span className="fx-label">{it.label}</span>
                    <div className="fx-slider-group">
                      <input
                        className="fx-slider"
                        type="range"
                        min={it.min}
                        max={it.max}
                        step={it.step}
                        value={Number(effects[it.key])}
                        onChange={(e) => setEffect(it.key, Number(e.target.value))}
                      />
                      <b className="fx-val">
                        {Number(effects[it.key]).toFixed(it.precision ?? 1)}
                        {it.suffix}
                      </b>
                    </div>
                  </div>
                )
              )}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}

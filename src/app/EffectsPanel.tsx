import { useAppStore, type Effects } from './store'
import { useI18n, type MessageKey } from '../i18n'

type Item =
  | { key: keyof Effects; label: MessageKey; kind: 'switch'; note?: MessageKey; disabled?: boolean }
  | {
      key: keyof Effects
      label: MessageKey
      kind: 'slider'
      min: number
      max: number
      step: number
      suffix: string
      precision?: number
      dependsOn?: keyof Effects
  }

function FoldIcon({ collapsed }: { collapsed: boolean }) {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true"><path d={collapsed ? 'm6 4 4 4-4 4' : 'm10 4-4 4 4 4'} /></svg>
}

const GROUPS: { name: MessageKey; items: Item[] }[] = [
  {
    name: 'effects.environment',
    items: [
      { key: 'atmosphereRing', label: 'effects.atmosphereRing', kind: 'switch' },
      { key: 'atmosphere', label: 'effects.atmosphere', kind: 'switch' },
      { key: 'stars', label: 'effects.stars', kind: 'switch' },
      { key: 'sunMoon', label: 'effects.sunMoon', kind: 'switch' },
      { key: 'sunGlow', label: 'effects.sunGlow', kind: 'slider', min: 0, max: 10, step: 0.5, suffix: '', precision: 1, dependsOn: 'sunMoon' },
      { key: 'fog', label: 'effects.fog', kind: 'switch' },
      { key: 'dayNight', label: 'effects.dayNight', kind: 'switch' },
    ],
  },
  {
    name: 'effects.terrain',
    items: [
      { key: 'globeTranslucency', label: 'effects.globeTranslucency', kind: 'switch' },
      { key: 'translucencyAlpha', label: 'effects.translucencyAlpha', kind: 'slider', min: 0.1, max: 1, step: 0.05, suffix: '', precision: 2, dependsOn: 'globeTranslucency' },
      { key: 'terrainExaggeration', label: 'effects.terrainExaggeration', kind: 'slider', min: 1, max: 100, step: 1, suffix: '', precision: 1 },
    ],
  },
  {
    name: 'effects.view',
    items: [
      { key: 'autoRotate', label: 'effects.autoRotate', kind: 'switch' },
    ],
  },
]

export function EffectsPanel() {
  const collapsed = useAppStore((s) => s.collapsedRight)
  const toggleCollapsed = useAppStore((s) => s.toggleCollapsedRight)
  const effects = useAppStore((s) => s.effects)
  const setEffect = useAppStore((s) => s.setEffect)
  const { t } = useI18n()

  return (
    <aside className={'panel panel-right' + (collapsed ? ' collapsed' : '')}>
      <div className="side-head">
        <span className="side-title">{t('effects.title')}</span>
        <button className="fold" data-testid="effects-panel-toggle" onClick={toggleCollapsed} title={collapsed ? t('effects.expand') : t('effects.collapse')}>
          <FoldIcon collapsed={collapsed} />
        </button>
      </div>
      <div className="panel-inner">
        {GROUPS.map((g) => (
          <section className="group" data-group={g.name} key={g.name}>
            <div className="group-head">
            <span className="group-name">{t(g.name)}</span>
            </div>
            <div className="fx-list">
              {g.items
                .filter((it) => !(it.kind === 'slider' && it.dependsOn && !effects[it.dependsOn]))
                .map((it) =>
                it.kind === 'switch' ? (
                  <div className="fx-row" data-effect-row={it.key} key={it.key}>
                    <span className={'fx-label' + (it.disabled ? ' fx-off' : '')}>
                      {t(it.label)}
                      {it.note ? <em className="fx-note">{t(it.note)}</em> : null}
                    </span>
                    <button
                      className={'fx-sw' + (effects[it.key] ? ' on' : '')}
                      data-effect={it.key}
                      onClick={() => !it.disabled && setEffect(it.key, !effects[it.key])}
                      disabled={it.disabled}
                      aria-label={t(it.label)}
                    />
                  </div>
                                ) : (
                  <div className="fx-row" data-effect-row={it.key} key={it.key}>

                    <span className="fx-label">{t(it.label)}</span>
                    <div className="fx-slider-group">
                      <input
                        className="fx-slider"
                        data-effect={it.key}
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

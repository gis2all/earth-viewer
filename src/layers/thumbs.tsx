const COLORS: Record<string, string> = {
  terrain: '#6e79d6',
  imagery: '#3e6b42',
  night: '#f0b06a',
  boundary: '#c9cede',
  population: '#f0b06a',
  landuse: '#4fae6f',
  weather: '#8fa0e8',
  quakes: '#ef5d67',
}

export function LayerThumb({ kind }: { kind: string }) {
  const c = COLORS[kind] ?? '#6e79d6'
  return (
    <svg viewBox="0 0 88 52" className="thumb" aria-hidden="true">
      <circle cx="44" cy="26" r="19" fill="var(--thumb-bg)" />
      <g fill="none" stroke={c} strokeWidth="1" opacity="0.85">
        <ellipse cx="44" cy="26" rx="19" ry="7.5" />
        <ellipse cx="44" cy="26" rx="12" ry="19" />
        <path d="M25 26h38M44 7v38" />
      </g>
      <circle cx="44" cy="26" r="2.4" fill={c} />
    </svg>
  )
}
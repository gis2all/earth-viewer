import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EffectsPanel } from './EffectsPanel'
import { useAppStore } from './store'

describe('EffectsPanel i18n', () => {
  beforeEach(() => {
    useAppStore.setState({ locale: 'zh-CN' })
  })

  it('renders Chinese effect labels', () => {
    render(<EffectsPanel />)
    expect(screen.getByText('大气散射')).toBeInTheDocument()
    expect(screen.getByText('星空背景')).toBeInTheDocument()
  })

  it('renders English effect labels', () => {
    useAppStore.setState({ locale: 'en' })
    render(<EffectsPanel />)
    expect(screen.getByText('Atmospheric Scattering')).toBeInTheDocument()
    expect(screen.getByText('Starfield')).toBeInTheDocument()
  })
})

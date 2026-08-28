import { describe, it, expect } from 'vitest'
import {
  assertTransition,
  canStartLoad,
  canTransition,
  isTerminal,
  LAYER_STATE_TRANSITIONS,
} from './stateMachine'
import type { LayerState } from './stateMachine'

const ALL_STATES: LayerState[] = ['pending', 'preflight', 'loading', 'ready', 'error', 'cancelled']

describe('状态机：合法转移', () => {
  it('从 pending 出发', () => {
    expect(canTransition('pending', 'preflight')).toBe(true)
    expect(canTransition('pending', 'loading')).toBe(true)
    expect(canTransition('pending', 'error')).toBe(true)
    expect(canTransition('pending', 'cancelled')).toBe(true)
  })

  it('加载链路 preflight → loading → ready', () => {
    expect(canTransition('preflight', 'loading')).toBe(true)
    expect(canTransition('loading', 'ready')).toBe(true)
  })

  it('ready / error 可被取消，error 是终态前的可回退态', () => {
    expect(canTransition('ready', 'error')).toBe(true)
    expect(canTransition('ready', 'cancelled')).toBe(true)
    expect(canTransition('error', 'cancelled')).toBe(true)
  })

  it('cancelled 是终态，不能继续转移', () => {
    for (const to of ALL_STATES) {
      expect(canTransition('cancelled', to)).toBe(false)
    }
  })
})

describe('状态机：非法转移', () => {
  it('禁止回退/跳级', () => {
    expect(canTransition('loading', 'pending')).toBe(false)
    expect(canTransition('ready', 'loading')).toBe(false)
    expect(canTransition('error', 'ready')).toBe(false)
    expect(canTransition('pending', 'ready')).toBe(false)
  })

  it('assertTransition 对非法转移抛错', () => {
    expect(() => assertTransition('loading', 'ready')).not.toThrow()
    expect(() => assertTransition('loading', 'pending')).toThrow(/非法状态转移/)
  })

  it('转移表覆盖全部状态', () => {
    for (const from of ALL_STATES) {
      expect(LAYER_STATE_TRANSITIONS[from]).toBeInstanceOf(Array)
    }
  })
})

describe('状态机：辅助判定', () => {
  it('isTerminal 仅 cancelled', () => {
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('ready')).toBe(false)
    expect(isTerminal('error')).toBe(false)
  })

  it('canStartLoad 仅 pending / preflight', () => {
    expect(canStartLoad('pending')).toBe(true)
    expect(canStartLoad('preflight')).toBe(true)
    expect(canStartLoad('loading')).toBe(false)
    expect(canStartLoad('ready')).toBe(false)
    expect(canStartLoad('error')).toBe(false)
    expect(canStartLoad('cancelled')).toBe(false)
  })
})

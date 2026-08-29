/**
 * 图层状态机类型（W1.3）。
 * 纯函数、零依赖：只定义合法状态与转移规则，W3.1 LayerController 按此落地。
 */

export type LayerState = 'pending' | 'preflight' | 'loading' | 'ready' | 'error' | 'cancelled'

/** 合法转移表：pending 是初始态；cancelled 是终态（removed 是删除事件而非状态）。 */
export const LAYER_STATE_TRANSITIONS: Readonly<Record<LayerState, readonly LayerState[]>> = {
  pending: ['preflight', 'loading', 'error', 'cancelled'],
  preflight: ['loading', 'error', 'cancelled'],
  loading: ['ready', 'error', 'cancelled'],
  ready: ['error', 'cancelled'],
  error: ['cancelled'],
  cancelled: [],
}

export function canTransition(from: LayerState, to: LayerState): boolean {
  return LAYER_STATE_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: LayerState, to: LayerState): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态转移: ${from} -> ${to}`)
  }
}

export function isTerminal(state: LayerState): boolean {
  return state === 'cancelled'
}

/** 该状态是否已不可再进入加载流程（终态或错误态）。 */
export function canStartLoad(state: LayerState): boolean {
  return state === 'pending' || state === 'preflight'
}

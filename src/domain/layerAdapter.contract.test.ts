import { describe, it, expect } from 'vitest'
import { LAYER_KINDS } from './types'
import type { LayerKind } from './types'
import type { LayerAdapter, LayerInput } from './layerAdapter'
import { LayerLoadError } from './layerAdapter'
import type { LayerRuntime } from './layerRuntime'
import { createEmptyRuntime } from './layerRuntime'

/**
 * LayerAdapter 契约测试模板（W0.3 骨架）。
 * M1 起所有真实 adapter 复用此模板；新增图层类型只需注册 adapter，
 * 契约自动覆盖 load 成功/失败/abort/estimateRisk。
 */
export function runAdapterContract(makeAdapter: (kind: LayerKind) => LayerAdapter) {
  describe('LayerAdapter 契约', () => {
    for (const kind of LAYER_KINDS) {
      describe(kind, () => {
        const adapter = makeAdapter(kind)
        const input: LayerInput = { id: kind + '-1', title: kind, type: kind, url: 'https://x/' + kind }

        it('kind 标识正确', () => {
          expect(adapter.kind).toBe(kind)
        })

        it('matches 识别自身 kind 的输入', () => {
          expect(adapter.matches(input)).toBe(true)
        })

        it('estimateRisk 返回合法分级', () => {
          const risk = adapter.estimateRisk(input)
          expect(['light', 'medium', 'heavy']).toContain(risk)
        })

        it('load 成功返回统一 runtime，dispose 幂等', async () => {
          const rt: LayerRuntime = await adapter.load({
            input,
            signal: new AbortController().signal,
            budget: { remaining: 5000 },
          })
          expect(rt).toMatchObject({ imagery: [], dataSources: [], primitives: [], vectorProviders: [] })
          expect(typeof rt.dispose).toBe('function')
          expect(() => {
            rt.dispose()
            rt.dispose()
          }).not.toThrow()
        })

        it('load 在已 abort 时抛统一错误', async () => {
          const ac = new AbortController()
          ac.abort()
          await expect(
            adapter.load({ input, signal: ac.signal, budget: { remaining: 5000 } })
          ).rejects.toBeInstanceOf(LayerLoadError)
        })
      })
    }
  })
}

// —— 占位实现（M0 骨架）：返回空 runtime；M1 接入真实 adapter 后删除 ——
function placeholderAdapter(kind: LayerKind): LayerAdapter {
  return {
    kind,
    matches: (input) => input.type === kind,
    estimateRisk: () => 'light',
    load: async ({ signal }) => {
      if (signal.aborted) throw new LayerLoadError('aborted', '加载已取消')
      return createEmptyRuntime()
    },
  }
}

runAdapterContract(placeholderAdapter)

import { describe, it, expect, vi } from 'vitest'
// 回归（W3.5）：共享 Cesium mock 只深 mock cesium/maplibre，不得覆盖业务模块 mock。
// 若此文件失败，说明共享 mock 又注册了 ogc/csv/geo 等业务模块的 vi.mock，
// 会以"后注册覆盖先注册"的方式吞掉测试文件自己的 mock 工厂。
import '../test/mocks/cesium'

const m = vi.hoisted(() => ({ fn: vi.fn(() => ({ type: 'FeatureCollection', features: [] })) }))

vi.mock('./ogc', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./ogc')>()
  return { ...mod, fetchOgcFeatureGeoJSON: m.fn }
})

import { fetchOgcFeatureGeoJSON as exported } from './ogc'

describe('共享 Cesium mock 与业务模块 mock 隔离', () => {
  it('测试文件的 hoisted mock 仍生效（未被共享 mock 覆盖）', () => {
    expect(m.fn as unknown as typeof exported === exported).toBe(true)
  })
})

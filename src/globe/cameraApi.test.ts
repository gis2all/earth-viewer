import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerViewer, unregisterViewer, resetView, orientView } from './cameraApi'
import { useAppStore } from '../state/store'

vi.mock('cesium', () => ({
  Cartesian3: { fromDegrees: (...a: number[]) => ({ tag: 'fromDegrees', args: a }) },
  Math: { toRadians: (d: number) => (d * Math.PI) / 180 },
}))

// mock 定位模块：返回固定用户位置
vi.mock('./geo', () => ({
  fetchUserHome: vi.fn(() => Promise.resolve({ lat: 31, lon: 121 })),
  UserHome: {},
}))

function makeViewer() {
  const flyTo = vi.fn()
  return {
    camera: {
      flyTo,
      position: { tag: 'position' },
      heading: 10,
      pitch: -0.5,
      roll: 3,
    },
    isDestroyed: () => false,
  }
}

describe('cameraApi', () => {
  beforeEach(() => {
    unregisterViewer()
    useAppStore.setState({ userHome: null })
    vi.clearAllMocks()
  })

  it('未注册 viewer 时 reset/orient 直接返回', async () => {
    await expect(resetView()).resolves.toBeUndefined()
    expect(() => orientView()).not.toThrow()
  })

  it('resetView 飞到用户位置（/api/geo），保持默认初始高度、垂直俯视', async () => {
    const v = makeViewer()
    registerViewer(v as never)
    await resetView()
    expect(v.camera.flyTo).toHaveBeenCalledTimes(1)
    const opts = v.camera.flyTo.mock.calls[0][0]
    // 用户位置 (lon 121, lat 31)，初始高度默认 20000000
    expect(opts.destination).toEqual({ tag: 'fromDegrees', args: [121, 31, 20000000] })
    expect(opts.orientation.heading).toBe(0)
    expect(opts.orientation.pitch).toBe(-Math.PI / 2)
  })

  it('registerViewer 时抓取初始高度，resetView 使用该高度', async () => {
    const v = makeViewer()
    ;(v.camera as { positionCartographic?: { height: number } }).positionCartographic = { height: 123456 }
    registerViewer(v as never)
    await resetView()
    const opts = v.camera.flyTo.mock.calls[0][0]
    expect(opts.destination).toEqual({ tag: 'fromDegrees', args: [121, 31, 123456] })
  })

  it('orientView 保持当前位置、垂直俯视朝北', () => {
    const v = makeViewer()
    registerViewer(v as never)
    orientView()
    expect(v.camera.flyTo).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: v.camera.position,
        orientation: expect.objectContaining({ heading: 0, roll: 0 }),
      })
    )
  })

  it('unregisterViewer 后不再触发飞行', async () => {
    const v = makeViewer()
    registerViewer(v as never)
    unregisterViewer()
    await resetView()
    orientView()
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })
})

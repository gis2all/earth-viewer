import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerViewer,
  unregisterViewer,
  resetView,
  orientView,
  flyToHome,
  setUserHomeResolver,
  setInitialHeightForTest,
} from './cameraActions'

vi.mock('cesium', () => ({
  Cartesian3: { fromDegrees: (...a: number[]) => ({ tag: 'fromDegrees', args: a }) },
  Math: { toRadians: (d: number) => (d * Math.PI) / 180 },
}))

function makeViewer() {
  const flyTo = vi.fn()
  const requestRender = vi.fn()
  return {
    camera: {
      flyTo,
      position: { tag: 'position' },
      heading: 10,
      pitch: -0.5,
      roll: 3,
    },
    scene: { requestRender },
    isDestroyed: () => false,
  }
}

describe('cameraActions', () => {
  beforeEach(() => {
    unregisterViewer()
    setUserHomeResolver(() => Promise.resolve({ lat: 31, lon: 121 }))
    vi.clearAllMocks()
  })

  it('未注册 viewer 时 reset/orient 直接返回', async () => {
    await expect(resetView()).resolves.toBeUndefined()
    expect(() => orientView()).not.toThrow()
  })

  it('未注入 resolver 时 resetView 直接返回', async () => {
    setUserHomeResolver(null)
    const v = makeViewer()
    registerViewer(v as never)
    await resetView()
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })

  it('resetView 飞到注入的 resolver 返回的用户位置，保持默认初始高度、垂直俯视', async () => {
    const v = makeViewer()
    registerViewer(v as never)
    await resetView()
    expect(v.camera.flyTo).toHaveBeenCalledTimes(1)
    const opts = v.camera.flyTo.mock.calls[0][0]
    // 用户位置 (lon 121, lat 31)，初始高度默认 20000000
    expect(opts.destination).toEqual({ tag: 'fromDegrees', args: [121, 31, 20000000] })
    expect(opts.orientation.heading).toBe(0)
    expect(opts.orientation.pitch).toBe(-Math.PI / 2)
    expect(v.scene.requestRender).toHaveBeenCalledTimes(1)
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
    expect(v.scene.requestRender).toHaveBeenCalledTimes(1)
  })

  it('unregisterViewer 后不再触发飞行', async () => {
    const v = makeViewer()
    registerViewer(v as never)
    unregisterViewer()
    await resetView()
    orientView()
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })

  it('flyToHome 显式传 viewer 但未注入 resolver 时直接返回', async () => {
    setUserHomeResolver(null)
    const v = makeViewer()
    await flyToHome(v as never)
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })

  it('flyToHome 的 resolver 失败（reject）时直接返回', async () => {
    setUserHomeResolver(() => Promise.reject(new Error('定位失败')))
    const v = makeViewer()
    registerViewer(v as never)
    await expect(flyToHome()).resolves.toBeUndefined()
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })

  it('flyToHome 未注册 viewer 但显式传参时直接返回', async () => {
    const v = makeViewer()
    await flyToHome(v as never)
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })

  it('flyToHome 目标 viewer 已销毁时直接返回', async () => {
    const v = makeViewer()
    registerViewer(v as never)
    ;(v as { isDestroyed: () => boolean }).isDestroyed = () => true
    await flyToHome()
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })

  it('setInitialHeightForTest 修改后的高度被 resetView 使用', async () => {
    setInitialHeightForTest(999)
    const v = makeViewer()
    registerViewer(v as never)
    await resetView()
    const opts = v.camera.flyTo.mock.calls[0][0]
    expect(opts.destination).toEqual({ tag: 'fromDegrees', args: [121, 31, 999] })
  })

  it('registerViewer 的 positionCartographic getter 抛错时被吞掉', async () => {
    const v = makeViewer()
    Object.defineProperty(v.camera, 'positionCartographic', {
      get() {
        throw new Error('camera 已销毁')
      },
    })
    expect(() => registerViewer(v as never)).not.toThrow()
    // 注册仍生效：resetView 会飞到用户位置
    setInitialHeightForTest(777)
    const fly = v.camera.flyTo
    await resetView()
    expect(fly.mock.calls[0][0].destination).toEqual({ tag: 'fromDegrees', args: [121, 31, 777] })
  })
})

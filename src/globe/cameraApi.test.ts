import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerViewer, unregisterViewer, resetView, orientView } from './cameraApi'

vi.mock('cesium', () => ({
  Cartesian3: { fromDegrees: (...a: number[]) => ({ tag: 'fromDegrees', args: a }) },
  Math: { toRadians: (d: number) => (d * Math.PI) / 180 },
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
  }
}

describe('cameraApi', () => {
  beforeEach(() => unregisterViewer())

  it('未注册 viewer 时 reset/orient 直接返回', () => {
    expect(() => resetView()).not.toThrow()
    expect(() => orientView()).not.toThrow()
  })

  it('resetView 飞回默认全球视角（heading 0 / pitch -90°）', () => {
    const v = makeViewer()
    registerViewer(v as never)
    resetView()
    expect(v.camera.flyTo).toHaveBeenCalledTimes(1)
    const opts = v.camera.flyTo.mock.calls[0][0]
    expect(opts.orientation.heading).toBe(0)
    expect(opts.orientation.pitch).toBe(-Math.PI / 2)
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

  it('unregisterViewer 后不再触发飞行', () => {
    const v = makeViewer()
    registerViewer(v as never)
    unregisterViewer()
    resetView()
    orientView()
    expect(v.camera.flyTo).not.toHaveBeenCalled()
  })
})

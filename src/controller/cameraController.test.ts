import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CameraController, type CameraControllerDeps, type CameraSurface } from './cameraController'

/** 捕获表面注册的回调，便于测试内手动触发；cleanup 为注册函数返回的注销函数。 */
function capture<T extends (...args: never[]) => void>() {
  const fns: T[] = []
  const cleanup = vi.fn()
  const reg = vi.fn((cb: T) => {
    fns.push(cb)
    return cleanup
  })
  return { fns, cleanup, reg }
}

function makeSurface(overrides: Partial<CameraSurface> = {}) {
  const wheel = capture<(e: WheelEvent) => void>()
  const pointerDown = capture<() => void>()
  const doubleClick = capture<(lon: number, lat: number) => void>()
  const postUpdate = capture<() => void>()
  type MockedSurface = CameraSurface & { [K in keyof CameraSurface]: ReturnType<typeof vi.fn> }
  const surface = {
    cameraPosition: vi.fn(() => ({ longitude: 1, latitude: 0.5, height: 10000 })),
    cameraOrientation: vi.fn(() => ({ heading: 0.1, pitch: -0.2, roll: 0 })),
    groundHeight: vi.fn(() => undefined),
    isFlying: vi.fn(() => false),
    cancelFlight: vi.fn(),
    moveForward: vi.fn(),
    setView: vi.fn(),
    flyToLonLat: vi.fn(),
    pickLonLat: vi.fn(() => ({ lon: 10, lat: 20 })),
    setScreenSpaceError: vi.fn(),
    requestFrame: vi.fn(),
    onWheel: wheel.reg,
    onPointerDown: pointerDown.reg,
    onDoubleClick: doubleClick.reg,
    onPostUpdate: postUpdate.reg,
    ...overrides,
  } as unknown as MockedSurface
  return { surface, wheel, pointerDown, doubleClick, postUpdate }
}

function setup(overrides: Partial<CameraControllerDeps> = {}) {
  const m = makeSurface()
  const autoRotate = vi.fn(() => false)
  const ctrl = new CameraController({ surface: m.surface, autoRotate, ...overrides })
  ctrl.attach()
  return { ctrl, ...m, autoRotate }
}

let now = 0

describe('CameraController（W3.2）', () => {
  beforeEach(() => {
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('滚轮 deltaY>0 放大目标高度（1.25）并按缓动推进相机、SSE 切到 2', () => {
    const { surface, wheel, postUpdate } = setup()
    wheel.fns[0]({ deltaY: 100, preventDefault: vi.fn() } as never)
    expect(surface.cancelFlight).toHaveBeenCalled()
    now = 100
    postUpdate.fns[0]()
    // targetH = 10000*1.25 = 12500 → diff = -2500 → moveForward(-2500*0.25)
    expect(surface.moveForward).toHaveBeenCalledWith(-625)
    expect(surface.setScreenSpaceError).toHaveBeenLastCalledWith(2)
    expect(surface.requestFrame).toHaveBeenCalled()
  })

  it('滚轮 deltaY<0 缩小目标高度（0.8）', () => {
    const { surface, wheel, postUpdate } = setup()
    wheel.fns[0]({ deltaY: -100, preventDefault: vi.fn() } as never)
    now = 50
    postUpdate.fns[0]()
    // targetH = 8000 → diff = 2000 → moveForward(2000*0.25)
    expect(surface.moveForward).toHaveBeenCalledWith(500)
  })

  it('目标高度不低于地形高度 +20', () => {
    const { surface, wheel, postUpdate } = setup()
    surface.cameraPosition.mockReturnValue({ longitude: 1, latitude: 0.5, height: 100 })
    surface.groundHeight.mockReturnValue(90)
    wheel.fns[0]({ deltaY: -100, preventDefault: vi.fn() } as never)
    now = 10
    postUpdate.fns[0]()
    // min = max(20, 110) = 110；h*0.8=80 → targetH = max(110, 80) = 110 → diff = -10
    expect(surface.moveForward).toHaveBeenCalledWith(-2.5)
  })

  it('双击 zoom in（0.5 倍、下限 MIN_ZOOM*2）', () => {
    const { surface, doubleClick } = setup()
    doubleClick.fns[0](30, 40)
    expect(surface.flyToLonLat).toHaveBeenCalledWith(30, 40, 5000, {
      heading: 0.1,
      pitch: -0.2,
      roll: 0,
    })
    surface.cameraPosition.mockReturnValue({ longitude: 1, latitude: 0.5, height: 50 })
    doubleClick.fns[0](30, 40)
    expect(surface.flyToLonLat).toHaveBeenLastCalledWith(30, 40, 40, {
      heading: 0.1,
      pitch: -0.2,
      roll: 0,
    })
  })

  it('无交互超过 idle 且 autoRotate 开启时经度递增', () => {
    const { surface, postUpdate } = setup({ autoRotate: () => true })
    now = 5000
    postUpdate.fns[0]()
    expect(surface.setView).toHaveBeenCalledWith(
      { longitude: 1 + 0.0012, latitude: 0.5, height: 10000 },
      { heading: 0.1, pitch: -0.2, roll: 0 }
    )
    expect(surface.requestFrame).toHaveBeenCalled()
  })

  it('飞行中不自动环绕', () => {
    const { surface, postUpdate } = setup({ autoRotate: () => true })
    surface.isFlying.mockReturnValue(true)
    now = 5000
    postUpdate.fns[0]()
    expect(surface.setView).not.toHaveBeenCalled()
  })

  it('pitch 超界时钳制到 [-89.9°, 0°]', () => {
    const { surface, postUpdate } = setup()
    surface.cameraOrientation.mockReturnValue({
      heading: 0.1,
      pitch: (-100 * Math.PI) / 180,
      roll: 0,
    })
    now = 10
    postUpdate.fns[0]()
    expect(surface.setView).toHaveBeenCalledWith(
      { longitude: 1, latitude: 0.5, height: 10000 },
      { heading: 0.1, pitch: (-89.9 * Math.PI) / 180, roll: 0 }
    )
  })

  it('缩放结束后连续 3 帧把 SSE 从 2 切回 1', () => {
    const { surface, wheel, postUpdate } = setup()
    wheel.fns[0]({ deltaY: 100, preventDefault: vi.fn() } as never)
    now = 100
    postUpdate.fns[0]()
    expect(surface.setScreenSpaceError).toHaveBeenLastCalledWith(2)
    // 相机高度到达目标后不再明显偏离
    surface.cameraPosition.mockReturnValue({ longitude: 1, latitude: 0.5, height: 12500 })
    now = 200
    postUpdate.fns[0]()
    now = 300
    postUpdate.fns[0]()
    now = 400
    postUpdate.fns[0]()
    expect(surface.setScreenSpaceError).toHaveBeenLastCalledWith(1)
  })

  it('按下鼠标取消飞行、关闭缓动窗口', () => {
    const { surface, wheel, pointerDown, postUpdate } = setup()
    wheel.fns[0]({ deltaY: 100, preventDefault: vi.fn() } as never)
    now = 200
    pointerDown.fns[0]()
    expect(surface.cancelFlight).toHaveBeenCalledTimes(2) // 滚轮 + 抓取
    now = 300
    postUpdate.fns[0]()
    expect(surface.setScreenSpaceError).toHaveBeenLastCalledWith(1)
    expect(surface.moveForward).not.toHaveBeenCalled()
  })

  it('wake() 在 autoRotate 开启时按剩余 idle 时间补一帧', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { ctrl, surface } = setup({ autoRotate: () => true })
      now = 1000
      ctrl.wake()
      vi.advanceTimersByTime(1999)
      expect(surface.requestFrame).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(surface.requestFrame).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 清理全部监听并阻止后续 attach', () => {
    const { ctrl, wheel, pointerDown, doubleClick, postUpdate } = setup()
    ctrl.dispose()
    expect(wheel.cleanup).toHaveBeenCalledTimes(1)
    expect(pointerDown.cleanup).toHaveBeenCalledTimes(1)
    expect(doubleClick.cleanup).toHaveBeenCalledTimes(1)
    expect(postUpdate.cleanup).toHaveBeenCalledTimes(1)
    ctrl.attach()
    expect(wheel.reg).toHaveBeenCalledTimes(1) // 不再新增监听
  })
})

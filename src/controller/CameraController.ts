/**
 * CameraController（W3.2）：收编 GlobeViewer 的相机交互逻辑。
 * - 滚轮缓动缩放（1.25/0.8、ZOOM_EASE 0.25）；
 * - 双击 zoom in（ratio 0.5、下限 MIN_ZOOM*2）；
 * - 自动环绕（无交互 3s 后沿东西方向递增经度）；
 * - 鼠标抓取取消飞行 + 关闭缓动窗口；
 * - pitch 钳制（-89.9° ~ 0°）；
 * - SSE 切换（缩放中 2 → 稳定后 1，高分屏清晰度对齐）。
 * 依赖注入 CameraSurface（CesiumFacade 实现），不 import Cesium。
 */

export interface CameraPosition {
  longitude: number
  latitude: number
  height: number
}

export interface CameraOrientation {
  heading: number
  pitch: number
  roll: number
}

/** 相机表面：CesiumFacade 实现，只暴露业务语义。 */
export interface CameraSurface {
  cameraPosition(): CameraPosition
  cameraOrientation(): CameraOrientation
  groundHeight(): number | undefined
  isFlying(): boolean
  cancelFlight(): void
  moveForward(distance: number): void
  setView(position: CameraPosition, orientation: CameraOrientation): void
  flyToLonLat(lon: number, lat: number, height: number, orientation: CameraOrientation): void
  pickLonLat(x: number, y: number): { lon: number; lat: number } | null
  setScreenSpaceError(value: number): void
  requestFrame(): void
  onWheel(cb: (e: WheelEvent) => void): () => void
  onPointerDown(cb: () => void): () => void
  onDoubleClick(cb: (lon: number, lat: number) => void): () => void
  onPostUpdate(cb: () => void): () => void
}

export interface CameraControllerDeps {
  surface: CameraSurface
  /** 实时读取 autoRotate 开关（避免闭包旧值）。 */
  autoRotate(): boolean
  minZoom?: number
  maxZoom?: number
  /** pitch 钳制区间（弧度）。 */
  minPitch?: number
  maxPitch?: number
  wheelOutFactor?: number
  wheelInFactor?: number
  autoRotateIdleMs?: number
  autoRotateStepRad?: number
  zoomEase?: number
  sseZooming?: number
  sseSettled?: number
  doubleClickZoomRatio?: number
}

const DEFAULT_MIN_ZOOM = 20
const DEFAULT_MAX_ZOOM = 25000000
const DEFAULT_MIN_PITCH = (-89.9 * Math.PI) / 180
const DEFAULT_MAX_PITCH = 0
const WHEEL_ZOOM_OUT_FACTOR = 1.25
const WHEEL_ZOOM_IN_FACTOR = 0.8
const AUTO_ROTATE_IDLE_MS = 3000
const AUTO_ROTATE_STEP_RAD = 0.0012
const ZOOM_EASE = 0.25
const SSE_ZOOMING = 2
const SSE_SETTLED = 1
const DOUBLE_CLICK_ZOOM_RATIO = 0.5
const WHEEL_ACTIVE_WINDOW_MS = 1500

export class CameraController {
  private cleanup: Array<() => void> = []
  private destroyed = false
  private targetH = 0
  private settledFrames = 0
  private lastWheel = -1e9
  private lastInteract = 0
  private wakeTimer: ReturnType<typeof setTimeout> | undefined

  private readonly minZoom: number
  private readonly maxZoom: number
  private readonly minPitch: number
  private readonly maxPitch: number
  private readonly wheelOut: number
  private readonly wheelIn: number
  private readonly idleMs: number
  private readonly stepRad: number
  private readonly zoomEase: number
  private readonly sseZooming: number
  private readonly sseSettled: number
  private readonly doubleClickRatio: number

  constructor(private deps: CameraControllerDeps) {
    this.minZoom = deps.minZoom ?? DEFAULT_MIN_ZOOM
    this.maxZoom = deps.maxZoom ?? DEFAULT_MAX_ZOOM
    this.minPitch = deps.minPitch ?? DEFAULT_MIN_PITCH
    this.maxPitch = deps.maxPitch ?? DEFAULT_MAX_PITCH
    this.wheelOut = deps.wheelOutFactor ?? WHEEL_ZOOM_OUT_FACTOR
    this.wheelIn = deps.wheelInFactor ?? WHEEL_ZOOM_IN_FACTOR
    this.idleMs = deps.autoRotateIdleMs ?? AUTO_ROTATE_IDLE_MS
    this.stepRad = deps.autoRotateStepRad ?? AUTO_ROTATE_STEP_RAD
    this.zoomEase = deps.zoomEase ?? ZOOM_EASE
    this.sseZooming = deps.sseZooming ?? SSE_ZOOMING
    this.sseSettled = deps.sseSettled ?? SSE_SETTLED
    this.doubleClickRatio = deps.doubleClickZoomRatio ?? DOUBLE_CLICK_ZOOM_RATIO
    this.targetH = deps.surface.cameraPosition().height
  }

  /** 挂载交互监听（滚轮/抓取/双击/每帧），返回后生效。 */
  attach(): void {
    if (this.destroyed) return
    const s = this.deps.surface
    this.cleanup.push(s.onWheel((e) => this.onWheel(e)))
    this.cleanup.push(s.onPointerDown(() => this.onUserGrab()))
    this.cleanup.push(s.onDoubleClick((lon, lat) => this.onDoubleClick(lon, lat)))
    this.cleanup.push(s.onPostUpdate(() => this.onFrame()))
    this.targetH = s.cameraPosition().height
  }

  /** 效果变化时唤醒自动环绕计时（原 autoRotateWakeRef.current()）。 */
  wake(): void {
    this.scheduleWake()
  }

  dispose(): void {
    this.destroyed = true
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    for (const c of this.cleanup) c()
    this.cleanup = []
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    const s = this.deps.surface
    s.cancelFlight()
    const h = s.cameraPosition().height
    const factor = e.deltaY > 0 ? this.wheelOut : this.wheelIn
    let min = this.minZoom
    const gh = s.groundHeight()
    if (gh !== undefined) min = Math.max(min, gh + 20)
    this.targetH = Math.max(min, Math.min(this.maxZoom, h * factor))
    this.lastWheel = performance.now()
    this.lastInteract = performance.now()
    this.scheduleWake()
    s.requestFrame()
  }

  private onUserGrab(): void {
    const s = this.deps.surface
    s.cancelFlight()
    this.lastWheel = -1e9
    this.lastInteract = performance.now()
    this.scheduleWake()
    s.requestFrame()
  }

  private onDoubleClick(lon: number, lat: number): void {
    const s = this.deps.surface
    const curH = s.cameraPosition().height
    const target = Math.max(this.minZoom * 2, curH * this.doubleClickRatio)
    s.flyToLonLat(lon, lat, target, {
      heading: s.cameraOrientation().heading,
      pitch: s.cameraOrientation().pitch,
      roll: 0,
    })
  }

  private onFrame(): void {
    const s = this.deps.surface
    let needsNextFrame = false
    // 自动旋转（无交互 3 秒后、且非飞行中）—— 沿东西方向绕地球转
    if (this.deps.autoRotate() && performance.now() - this.lastInteract > this.idleMs && !s.isFlying()) {
      const p = s.cameraPosition()
      s.setView(
        { longitude: p.longitude + this.stepRad, latitude: p.latitude, height: p.height },
        s.cameraOrientation()
      )
      needsNextFrame = true
    }
    // pitch 钳制
    const o = s.cameraOrientation()
    if (o.pitch < this.minPitch || o.pitch > this.maxPitch) {
      s.setView(s.cameraPosition(), {
        heading: o.heading,
        pitch: Math.max(this.minPitch, Math.min(this.maxPitch, o.pitch)),
        roll: o.roll,
      })
      needsNextFrame = true
    }
    // 滚轮缓动 + SSE 切换
    const h = s.cameraPosition().height
    const diff = h - this.targetH
    const wheelActive = performance.now() - this.lastWheel < WHEEL_ACTIVE_WINDOW_MS
    if (wheelActive) {
      if (Math.abs(diff) > 1) s.moveForward(diff * this.zoomEase)
      if (Math.abs(diff) > h * 0.005) {
        this.settledFrames = 0
        s.setScreenSpaceError(this.sseZooming)
      } else {
        this.settledFrames++
        // 缩放刚停就尽快回到该高度的常规精度，避免"停止后仍糊很久"
        if (this.settledFrames > 2) s.setScreenSpaceError(this.sseSettled)
      }
      needsNextFrame = true
    } else {
      this.targetH = h
      s.setScreenSpaceError(this.sseSettled)
    }
    if (needsNextFrame) s.requestFrame()
  }

  private scheduleWake(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    if (this.destroyed || !this.deps.autoRotate()) return
    const elapsed = performance.now() - this.lastInteract
    const delay = Math.max(0, this.idleMs - elapsed)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      if (!this.destroyed && this.deps.autoRotate()) this.deps.surface.requestFrame()
    }, delay)
  }
}

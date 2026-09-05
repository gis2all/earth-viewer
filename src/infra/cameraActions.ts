import * as Cesium from 'cesium'
import type { UserHome } from '../domain/types'

let viewer: Cesium.Viewer | null = null
// 程序默认启动时的相机高度（用于"回到用户位置"的缩放）
let initialHeight = 20000000

/** 用户位置解析器（组合根注入；infra 不直接依赖 service/store）。 */
export type UserHomeResolver = () => Promise<UserHome>

let resolveUserHome: UserHomeResolver | null = null

/** 测试/组合根用：注入用户位置解析器（传 null 可清除）。 */
export function setUserHomeResolver(resolver: UserHomeResolver | null): void {
  resolveUserHome = resolver
}

function requestViewerRender(v: Cesium.Viewer) {
  if (!v.isDestroyed?.()) v.scene?.requestRender?.()
}

export function registerViewer(v: Cesium.Viewer) {
  viewer = v
  try {
    const h = v.camera.positionCartographic?.height
    if (typeof h === 'number' && Number.isFinite(h) && h > 0) initialHeight = h
  } catch {
    // ignore
  }
}

export function unregisterViewer() {
  viewer = null
}

/** 飞到"程序初始位置"：以用户大概位置为中心，保持默认启动缩放高度。 */
export async function flyToHome(v?: Cesium.Viewer) {
  const target = v ?? viewer
  if (!target || !resolveUserHome) return
  const home = await resolveUserHome().catch(() => null)
  if (!home) return
  if (!viewer || target.isDestroyed?.()) return
  target.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, initialHeight),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  })
  requestViewerRender(target)
}

/** 复位：异步取用户位置后飞回初始视角（不再写死坐标）。 */
export function resetView() {
  return flyToHome()
}

/** 回正：保持位置，动画飞回垂直俯视、朝北（与复位一致的 flyTo） */
export function orientView() {
  const v = viewer
  if (!v) return
  const c = v.camera
  c.flyTo({
    destination: c.position,
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  })
  requestViewerRender(v)
}

/** 指南针：保持位置与当前俯仰/滚转，只把方位转到正北（不改变翻的角度）。 */
export function orientNorth() {
  const v = viewer
  if (!v) return
  const c = v.camera
  c.flyTo({
    destination: c.position,
    orientation: { heading: 0, pitch: c.pitch, roll: c.roll },
  })
  requestViewerRender(v)
}

/** 测试用：重置内部初始高度。 */
export function setInitialHeightForTest(h: number) {
  initialHeight = h
}

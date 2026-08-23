import * as Cesium from 'cesium'
import { fetchUserHome, type UserHome } from './geo'
import { useAppStore } from '../state/store'

let viewer: Cesium.Viewer | null = null
// 程序默认启动时的相机高度（用于"回到用户位置"的缩放）
let initialHeight = 20000000

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

/** 取当前用户大概位置（优先内存缓存，否则请求 /api/geo）。 */
async function resolveUserHome(): Promise<UserHome> {
  const fromStore = useAppStore.getState().userHome
  if (fromStore) return fromStore
  const h = await fetchUserHome()
  useAppStore.getState().setUserHome(h)
  return h
}

/** 飞到"程序初始位置"：以用户大概位置为中心，保持默认启动缩放高度。 */
export async function flyToHome(v?: Cesium.Viewer) {
  const target = v ?? viewer
  if (!target) return
  const home = await resolveUserHome()
  if (!viewer || target.isDestroyed?.()) return
  target.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, initialHeight),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  })
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
}

/** 测试用：重置内部初始高度。 */
export function setInitialHeightForTest(h: number) {
  initialHeight = h
}

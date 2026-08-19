import * as Cesium from 'cesium'

let viewer: Cesium.Viewer | null = null

export function registerViewer(v: Cesium.Viewer) {
  viewer = v
}

export function unregisterViewer() {
  viewer = null
}

/** 复位：飞回默认全球视角 */
export function resetView() {
  const v = viewer
  if (!v) return
  v.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(104, 35, 20000000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  })
}

/** 回正：保持位置，视角拉回垂直俯视、朝北 */
export function orientView() {
  const v = viewer
  if (!v) return
  const c = v.camera
  c.setView({
    destination: c.position,
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  })
}

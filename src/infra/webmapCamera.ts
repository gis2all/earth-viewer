/**
 * Web Map / Web Scene 初始相机解析（W3.5 从 GlobeViewer 抽出）。
 * 相位 position 常为 3857 投影（x/y 为米），需反投影到 lon/lat；heading 为方位角(度)，
 * tilt 为自天顶倾角(0=俯视)。
 */
import * as Cesium from 'cesium'
import { reprojectCoordinates } from './vector'

export interface ViewpointCamera {
  destination: Cesium.Cartesian3
  orientation: { heading: number; pitch: number; roll: number }
  /** 相机高出椭球的高度（米），来自 viewpoint 的 position.z；用于上限判定。 */
  heightMeters?: number
}

function positionToCartesian(pos: Record<string, unknown> | undefined): Cesium.Cartesian3 | null {
  if (!pos) return null
  const x = Number(pos.x)
  const y = Number(pos.y)
  const z = Number(pos.z ?? 0)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const sr = pos.spatialReference as { wkid?: number; latestWkid?: number } | undefined
  const wkid = sr?.wkid ?? sr?.latestWkid
  if (wkid === 3857 || wkid === 102100 || wkid === 102113) {
    try {
      const [lon, lat] = reprojectCoordinates([x, y], 'EPSG:3857', 'EPSG:4326') as [number, number]
      return Cesium.Cartesian3.fromDegrees(lon, lat, z)
    } catch {
      return Cesium.Cartesian3.fromDegrees(x, y, z)
    }
  }
  // 4326 或缺省：x=lon(度), y=lat(度)
  return Cesium.Cartesian3.fromDegrees(x, y, z)
}

export function viewpointCameraFromWebmap(wm: Record<string, unknown> | undefined): ViewpointCamera | null {
  if (!wm) return null
  const initialState = wm.initialState as Record<string, unknown> | undefined
  const vp = ((wm.viewpoint ?? initialState?.viewpoint) as { camera?: { position?: Record<string, unknown>; heading?: number; tilt?: number } } | undefined)
  const cam = vp?.camera
  if (!cam?.position) return null
  const destination = positionToCartesian(cam.position as Record<string, unknown>)
  if (!destination) return null
  const heading = Cesium.Math.toRadians(cam.heading ?? 0)
  // tilt: 0=俯视(向下)，90=水平；Cesium pitch: -90=俯视，0=水平 → pitch = tilt - 90
  const pitch = Cesium.Math.toRadians((cam.tilt ?? 0) - 90)
  const heightMeters = Number(cam.position.z ?? 0)
  return {
    destination,
    orientation: { heading, pitch, roll: 0 },
    heightMeters: Number.isFinite(heightMeters) ? heightMeters : undefined,
  }
}

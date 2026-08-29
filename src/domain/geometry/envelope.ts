/** 视口经纬度范围（度）。 */
export interface ViewEnvelope {
  west: number
  south: number
  east: number
  north: number
}

/** Cesium Rectangle 的 four corners（弧度）→ 经纬度（度）。视口驱动查询用。 */
export function rectangleToEnvelope(rect: { west: number; south: number; east: number; north: number } | undefined | null): ViewEnvelope | null {
  if (!rect) return null
  const rad = Math.PI / 180
  return {
    west: rect.west / rad,
    south: rect.south / rad,
    east: rect.east / rad,
    north: rect.north / rad,
  }
}

/** 从 Cesium camera（或其 mock）计算视口 envelope；无则回退全局。 */
export function viewEnvelopeFromCamera(
  camera: { computeViewRectangle?: () => { west: number; south: number; east: number; north: number } | undefined } | undefined | null
): ViewEnvelope | null {
  if (!camera?.computeViewRectangle) return null
  const rect = camera.computeViewRectangle()
  return rectangleToEnvelope(rect as { west: number; south: number; east: number; north: number } | undefined | null)
}

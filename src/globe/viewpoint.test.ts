import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('cesium', () => ({
  Cartesian3: {
    fromDegrees: vi.fn((lon: number, lat: number, height: number) => ({ lon, lat, height })),
  },
  Math: {
    toRadians: (d: number) => (d * Math.PI) / 180,
  },
}))

vi.mock('./facade/vector', () => ({
  reprojectCoordinates: vi.fn(),
}))

import { viewpointCameraFromWebmap } from './facade/viewpoint'
import { reprojectCoordinates } from './facade/vector'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('viewpointCameraFromWebmap（W3.5）', () => {
  it('无 webmap 或相机位置时返回 null', () => {
    expect(viewpointCameraFromWebmap(undefined)).toBeNull()
    expect(viewpointCameraFromWebmap({ viewpoint: { camera: {} } })).toBeNull()
  })

  it('3857 位置反投影为经纬度，heading/tilt 转弧度', () => {
    vi.mocked(reprojectCoordinates).mockReturnValue([116.39, 39.9])
    const vp = viewpointCameraFromWebmap({
      initialState: {
        viewpoint: {
          camera: {
            position: { x: 12958175, y: 4853645, z: 100, spatialReference: { wkid: 3857 } },
            heading: 90,
            tilt: 30,
          },
        },
      },
    })
    expect(reprojectCoordinates).toHaveBeenCalledWith([12958175, 4853645], 'EPSG:3857', 'EPSG:4326')
    expect(vp).toEqual({
      destination: { lon: 116.39, lat: 39.9, height: 100 },
      orientation: { heading: Math.PI / 2, pitch: (-60 * Math.PI) / 180, roll: 0 },
    })
  })

  it('3857 反投影失败回退 fromDegrees(x, y, z)', () => {
    vi.mocked(reprojectCoordinates).mockImplementation(() => {
      throw new Error('proj fail')
    })
    const vp = viewpointCameraFromWebmap({
      viewpoint: {
        camera: { position: { x: 10, y: 20, spatialReference: { wkid: 102100 } } },
      },
    })
    expect(vp!.destination).toEqual({ lon: 10, lat: 20, height: 0 })
  })

  it('4326 或缺省直接作为经纬度，heading/tilt 缺省为 0', () => {
    const vp = viewpointCameraFromWebmap({
      viewpoint: {
        camera: { position: { x: 116.39, y: 39.9, spatialReference: { wkid: 4326 } } },
      },
    })
    expect(vp!.destination).toEqual({ lon: 116.39, lat: 39.9, height: 0 })
    expect(vp!.orientation).toEqual({ heading: 0, pitch: (-90 * Math.PI) / 180, roll: 0 })
  })
})

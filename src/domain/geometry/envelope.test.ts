import { describe, it, expect } from 'vitest'
import { rectangleToEnvelope, viewEnvelopeFromCamera } from './envelope'

describe('envelope', () => {
  it('rectangle 弧度转经纬度', () => {
    const e = rectangleToEnvelope({ west: Math.PI, south: -Math.PI / 2, east: 2 * Math.PI, north: Math.PI / 2 })
    expect(e?.west).toBeCloseTo(180)
    expect(e?.north).toBeCloseTo(90)
    expect(e?.south).toBeCloseTo(-90)
    expect(rectangleToEnvelope(null)).toBeNull()
  })
})

describe('viewEnvelopeFromCamera', () => {
  it('有 computeViewRectangle 时转经纬度，无则 null', () => {
    expect(viewEnvelopeFromCamera({ computeViewRectangle: () => ({ west: Math.PI, south: -Math.PI / 2, east: 2 * Math.PI, north: Math.PI / 2 }) })?.west).toBeCloseTo(180)
    expect(viewEnvelopeFromCamera({})).toBeNull()
    expect(viewEnvelopeFromCamera(undefined)).toBeNull()
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  appConfig,
  configureApp,
  resetAppConfig,
} from './config'

describe('appConfig / configureApp / resetAppConfig', () => {
  beforeEach(() => resetAppConfig())

  it('默认值与 DEFAULT_APP_CONFIG 相同', () => {
    expect(appConfig()).toEqual(DEFAULT_APP_CONFIG)
  })

  it('局部覆盖顶层字段，其余默认保留', () => {
    const next = configureApp({ maxFeatures: 100, imageryMaxLevel: 8 })
    expect(next.maxFeatures).toBe(100)
    expect(next.imageryMaxLevel).toBe(8)
    expect(next.maxTotalFeatures).toBe(DEFAULT_APP_CONFIG.maxTotalFeatures)
    expect(next.camera).toEqual(DEFAULT_APP_CONFIG.camera)
  })

  it('viewportFallback 整体替换（非浅合并）', () => {
    configureApp({ viewportFallback: { west: -10, south: -10, east: 10, north: 10 } })
    expect(appConfig().viewportFallback).toEqual({ west: -10, south: -10, east: 10, north: 10 })
    expect(appConfig().viewportFallback).not.toBe(DEFAULT_APP_CONFIG.viewportFallback)
  })

  it('camera 与 panel 子对象按字段浅合并', () => {
    configureApp({ camera: { minZoom: 50 }, panel: { galleryPage: 6 } })
    expect(appConfig().camera).toEqual({ ...DEFAULT_APP_CONFIG.camera, minZoom: 50 })
    expect(appConfig().panel).toEqual({ ...DEFAULT_APP_CONFIG.panel, galleryPage: 6 })
    expect(appConfig().camera.maxZoom).toBe(DEFAULT_APP_CONFIG.camera.maxZoom)
  })

  it('连续覆盖在上一次结果上累积', () => {
    configureApp({ maxFeatures: 100 })
    const next = configureApp({ maxTotalFeatures: 900 })
    expect(next.maxFeatures).toBe(100)
    expect(next.maxTotalFeatures).toBe(900)
  })

  it('resetAppConfig 恢复默认', () => {
    configureApp({ maxFeatures: 1, camera: { minZoom: 1 }, viewportFallback: { west: 0, south: 0, east: 1, north: 1 } })
    resetAppConfig()
    expect(appConfig()).toEqual(DEFAULT_APP_CONFIG)
  })
})

/**
 * GlobeViewer（W3.5）：退化为"创建 CesiumFacade + 订阅三个 Controller + 转发渲染唤醒"。
 * - 不再直接 import Cesium / 不再持有渲染资源表；
 * - 图层生命周期（状态机/串行队列/释放）归 LayerController；
 * - 相机交互（滚轮/双击/环绕/SSE）归 CameraController；
 * - 效果/主题同步归 EffectsController；
 * - Cesium 接触面收敛到 CesiumFacade（本组件只保留 WebGL 守卫与提示浮层）。
 */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store'
import { CesiumFacade, isWebglAvailable } from '../infra/cesiumFacade'
import { setUserHomeResolver } from '../infra/cameraActions'
import { CameraController } from '../controller/cameraController'
import { EffectsController } from '../controller/effectsController'
import { LayerController } from '../controller/layerController'
import { renderWebmap } from '../globe/globeRenderer'
import { createEmptyRuntime } from '../domain/layerRuntime'
import { fetchUserHome } from '../service/userLocation'

const WEBGL_UNAVAILABLE_MSG =
  '当前浏览器无法创建 WebGL，地球无法渲染。请使用开启硬件加速的 Chrome/Edge 访问（Codex内置浏览器 / 无GPU环境不支持）'

export function GlobeViewer() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const facadeRef = useRef<CesiumFacade | null>(null)
  const cameraCtrlRef = useRef<CameraController | null>(null)
  const layerCtrlRef = useRef<LayerController | null>(null)
  const effectsCtrlRef = useRef<EffectsController | null>(null)
  const added = useAppStore((s) => s.added)
  const theme = useAppStore((s) => s.theme)
  const effects = useAppStore((s) => s.effects)
  const [glError, setGlError] = useState('')
  const [layerNote, setLayerNote] = useState('')

  // 创建 CesiumFacade + 三个控制器（仅一次）
  useEffect(() => {
    const el = containerRef.current
    if (!el || facadeRef.current) return
    // E2E 测试模式：headless CI 的软件渲染 WebGL 极慢，UI 交互测试不需要球 → 跳过 Cesium Viewer
    if ((window as unknown as { __E2E__?: boolean }).__E2E__) return
    if (!isWebglAvailable()) {
      setGlError(WEBGL_UNAVAILABLE_MSG)
      return
    }

    const facade = new CesiumFacade()
    const ok = facade.create(el, {
      onContextLost: (msg) => setGlError(msg),
      onContextRestored: () => setGlError(''),
      onInitError: (msg) => setGlError(msg),
    })
    if (!ok) return
    facadeRef.current = facade

    // 用户定位解析器（组合根注入）：优先 store 内存缓存，否则请求 /api/geo 并回写
    setUserHomeResolver(async () => {
      const fromStore = useAppStore.getState().userHome
      if (fromStore) return fromStore
      const h = await fetchUserHome()
      useAppStore.getState().setUserHome(h)
      return h
    })

    // 真实地形 + 首次视角 + 底图（影像 + 矢量标注）
    void facade.applyTerrain()
    facade.flyToHome()
    const baseRuntime = createEmptyRuntime()
    facade.addBaseLayers(baseRuntime)

    const cameraCtrl = new CameraController({
      surface: facade,
      autoRotate: () => useAppStore.getState().effects.autoRotate,
    })
    cameraCtrl.attach()
    cameraCtrlRef.current = cameraCtrl

    const layerCtrl = new LayerController({
      render: (job) => renderWebmap(job, facade),
      setError: (id, msg) => useAppStore.getState().setLayerError(id, msg),
      clearError: (id) => useAppStore.getState().clearLayerError(id),
      setNote: (msg) => setLayerNote(msg),
      getReferenceVisible: () => useAppStore.getState().effects.showReferenceLayers ?? true,
      removeRuntime: (rt) => facade.removeRuntime(rt),
    })
    layerCtrlRef.current = layerCtrl

    const effectsCtrl = new EffectsController({
      surface: facade,
      theme: () => useAppStore.getState().theme,
      effects: () => {
        const e = useAppStore.getState().effects
        return {
          atmosphere: e.atmosphere,
          stars: e.stars,
          sunMoon: e.sunMoon,
          fog: e.fog,
          dayNight: e.dayNight,
          terrainExaggeration: e.terrainExaggeration,
          globeTranslucency: e.globeTranslucency,
          translucencyAlpha: e.translucencyAlpha,
        }
      },
      onChanged: () => cameraCtrl.wake(),
    })
    effectsCtrlRef.current = effectsCtrl

    return () => {
      setUserHomeResolver(null)
      effectsCtrl.dispose()
      cameraCtrl.dispose()
      layerCtrl.dispose()
      facade.removeRuntime(baseRuntime)
      facade.destroy()
      effectsCtrlRef.current = null
      cameraCtrlRef.current = null
      layerCtrlRef.current = null
      facadeRef.current = null
    }
  }, [])

  // 场景级效果/主题变化 → 同步场景副作用（控制器内部会唤醒相机 + 请求一帧）
  useEffect(() => {
    effectsCtrlRef.current?.sync()
  }, [effects, theme])

  // 图层管理：store.added 变化 → 控制器差分同步（渲染/释放由 LayerController + renderWebmap 负责）
  useEffect(() => {
    layerCtrlRef.current?.setItems(added.filter((a) => a.kind === 'webmap' && a.webmap))
  }, [added])

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {glError && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, padding: 24, textAlign: 'center', background: 'rgba(0,0,0,0.6)', zIndex: 10 }}>
          {glError}
        </div>
      )}
      {layerNote && (
        <div
          style={{ position: 'absolute', left: 12, bottom: 12, maxWidth: '70%', padding: '8px 12px', borderRadius: 8, background: 'rgba(20,24,32,0.85)', color: '#fff', fontSize: 13, zIndex: 9, pointerEvents: 'none' }}
          role="status"
        >
          {layerNote}
        </div>
      )}
    </div>
  )
}

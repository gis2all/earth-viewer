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
import type { BottomStatus } from './BottomStatusBar'
import { hasOwnBasemap } from '../domain/layerAssessment'

const WEBGL_UNAVAILABLE_MSG =
  '当前浏览器无法创建 WebGL，地球无法渲染。请使用开启硬件加速的 Chrome/Edge 访问（Codex内置浏览器 / 无GPU环境不支持）'

export function GlobeViewer({ onStatus, onHeading }: { onStatus?: (s: BottomStatus) => void; onHeading?: (heading: number) => void }) {
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
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusCleanupRef = useRef<(() => void) | null>(null)

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
      creditContainer: document.getElementById('cesium-credit-container') ?? undefined,
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
      setNote: (msg) => {
        setLayerNote(msg)
        if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
        noteTimerRef.current = window.setTimeout(() => setLayerNote(''), 5000)
      },
      // 区划网格默认开启且不再暴露 UI 开关：恒 true，避免持久化残留/误关影响参考层渲染
      getReferenceVisible: () => true,
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
          sunGlow: e.sunGlow,
          atmosphereRing: e.atmosphereRing,
        }
      },
      onChanged: () => cameraCtrl.wake(),
    })
    effectsCtrlRef.current = effectsCtrl

    // 底部状态栏实时信息：鼠标经纬度优先，无鼠标数据时用相机中心；高度取相机高度
    if (onStatus) {
      let hasPointer = false
      let pointerLon = 0
      let pointerLat = 0
      const send = (lon: number, lat: number) => {
        const p = facade.cameraPosition()
        onStatus({ lon, lat, height: p.height })
      }
      const reportCamera = () => {
        if (onHeading) onHeading(facade.cameraOrientation().heading)
        // 每帧只更新高度（经纬度保持鼠标位置；无鼠标数据时才用相机中心）
        if (!hasPointer) {
          const p = facade.cameraPosition()
          onStatus({ lon: (p.longitude * 180) / Math.PI, lat: (p.latitude * 180) / Math.PI, height: p.height })
        } else {
          send(pointerLon, pointerLat)
        }
      }
      const offMove = facade.onPointerMove((lon, lat) => {
        hasPointer = true
        pointerLon = lon
        pointerLat = lat
        send(lon, lat)
      })
      const offPost = facade.onPostUpdate(reportCamera)
      statusCleanupRef.current = () => { offMove(); offPost() }
      reportCamera()
    } else if (onHeading) {
      // 无 status 订阅但需要 heading（顶栏指南针）：单独每帧上报相机 heading
      const hb = () => onHeading(facade.cameraOrientation().heading)
      const offPost = facade.onPostUpdate(hb)
      statusCleanupRef.current = () => offPost()
      hb()
    }

    return () => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      setUserHomeResolver(null)
      effectsCtrl.dispose()
      cameraCtrl.dispose()
      layerCtrl.dispose()
      facade.removeRuntime(baseRuntime)
      facade.destroy()
      statusCleanupRef.current?.()
      statusCleanupRef.current = null
      effectsCtrlRef.current = null
      cameraCtrlRef.current = null
      layerCtrlRef.current = null
      facadeRef.current = null
    }
  }, [onStatus, onHeading])

  // 场景级效果/主题变化 → 同步场景副作用（控制器内部会唤醒相机 + 请求一帧）
  useEffect(() => {
    effectsCtrlRef.current?.sync()
  }, [effects, theme])

  // 图层管理：store.added 变化 → 控制器差分同步（渲染/释放由 LayerController + renderWebmap 负责）
  useEffect(() => {
    layerCtrlRef.current?.setItems(added.filter((a) => a.kind === 'webmap' && a.webmap))
  }, [added])

  // 固定底图可见性：任一 webmap 自带可替代底图时隐藏，避免其透明像素把 WGS84 影像与标注透出；
  // 全部移除后恢复固定底图。
  useEffect(() => {
    const f = facadeRef.current
    if (!f) return
    const anyOwnBasemap = added.some(
      (a) => a.kind === 'webmap' && a.webmap && hasOwnBasemap(a.webmap)
    )
    f.setBaseVisible(!anyOwnBasemap)
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
          className="globe-note"
          role="status"
        >
          {layerNote}
        </div>
      )}
    </div>
  )
}

/**
 * EffectsController（W3.3）：把"效果/主题变更 → 场景副作用"收敛为单一入口。
 * - 大气 / 星空 / 日月 / 雾 / 昼夜光照 / 地形夸张 / 半透明 / 背景色；
 * - 变更后唤醒相机（自动环绕计时重排）+ 请求一帧。
 * 依赖注入 EffectsSurface（CesiumFacade 实现），不 import Cesium / store。
 */

export interface EffectsSurface {
  setAtmosphere(show: boolean): void
  setBackgroundColor(color: string): void
  setSkyBox(show: boolean): void
  setSunMoon(show: boolean): void
  setFog(enabled: boolean): void
  setLighting(enabled: boolean): void
  setVerticalExaggeration(value: number): void
  setTranslucency(enabled: boolean, alpha: number): void
  requestFrame(): void
}

/** EffectsController 只读的效果快照（结构兼容 store.Effects）。 */
export interface EffectsSnapshot {
  atmosphere: boolean
  stars: boolean
  sunMoon: boolean
  fog: boolean
  dayNight: boolean
  terrainExaggeration: number
  globeTranslucency: boolean
  translucencyAlpha: number
}

export interface EffectsControllerDeps {
  surface: EffectsSurface
  theme(): 'light' | 'dark'
  effects(): EffectsSnapshot
  /** 效果/主题同步完成后的唤醒钩子（相机自动环绕计时重排等）。 */
  onChanged(): void
}

export class EffectsController {
  private disposed = false

  constructor(private deps: EffectsControllerDeps) {}

  /** 把当前效果快照同步到渲染表面；主题/效果任一变化后调用。 */
  sync(): void {
    if (this.disposed) return
    const e = this.deps.effects()
    const dark = this.deps.theme() === 'dark'
    const s = this.deps.surface
    s.setAtmosphere(e.atmosphere)
    // 背景与星空跟随主题：白天白底（无星空），深色深空（可选星空）
    s.setBackgroundColor(dark ? '#05070d' : '#ffffff')
    s.setSkyBox(dark && e.stars)
    s.setSunMoon(e.sunMoon)
    s.setFog(e.fog)
    s.setLighting(e.dayNight)
    s.setVerticalExaggeration(e.terrainExaggeration)
    s.setTranslucency(e.globeTranslucency, e.translucencyAlpha)
    this.deps.onChanged()
    s.requestFrame()
  }

  dispose(): void {
    this.disposed = true
  }
}

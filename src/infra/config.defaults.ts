/**
 * 运行时配置（W4.2）：默认值来自 domain/config.ts 的 DEFAULT_APP_CONFIG。
 * - 提供 configureApp() 在运行时整体/局部覆盖（如注入 window 配置、E2E 覆盖）；
 * - appConfig() 返回当前生效配置；resetAppConfig() 恢复默认（测试用）。
 * - 注意：模块加载时已读取的值不会自动刷新；覆盖需在相关模块初始化前完成。
 */
import { DEFAULT_APP_CONFIG, type AppConfig } from '../domain/config'

let current: AppConfig = DEFAULT_APP_CONFIG

export function configureApp(overrides: Partial<AppConfig>): AppConfig {
  current = {
    ...current,
    ...overrides,
    viewportFallback: overrides.viewportFallback ?? current.viewportFallback,
    camera: { ...current.camera, ...overrides.camera },
    panel: { ...current.panel, ...overrides.panel },
  }
  return current
}

export function appConfig(): AppConfig {
  return current
}

export function resetAppConfig(): void {
  current = DEFAULT_APP_CONFIG
}

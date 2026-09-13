export type Locale = 'zh-CN' | 'en'

/** 首次访问按浏览器语言选择；所有 zh-* 都进入中文，其余进入英文。 */
export function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  const language = navigator.languages?.[0] ?? navigator.language ?? ''
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

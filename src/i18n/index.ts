import { useMemo } from 'react'
import { useAppStore } from '../app/store'
import type { Locale } from './locale'
import { translate, translateAppMessage, type MessageKey } from './messages'
import type { AppMessage } from '../domain/appMessage'

export type { Locale } from './locale'
export { detectBrowserLocale } from './locale'
export type { MessageKey } from './messages'

export function useI18n() {
  const locale = useAppStore((state) => state.locale)
  return useMemo(
    () => ({
      locale,
      t: (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params),
      tm: (message: AppMessage) => translateAppMessage(locale, message),
    }),
    [locale]
  )
}

export function localeLabel(locale: Locale): string {
  return locale === 'zh-CN' ? '中' : 'EN'
}

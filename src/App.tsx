import { useEffect } from 'react'
import { AppShell } from './app/AppShell'
import { useAppStore } from './app/store'

export default function App() {
  const theme = useAppStore((s) => s.theme)
  const locale = useAppStore((s) => s.locale)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return <AppShell />
}

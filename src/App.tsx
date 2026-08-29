import { useEffect } from 'react'
import { AppShell } from './app/AppShell'
import { useAppStore } from './app/store'

export default function App() {
  const theme = useAppStore((s) => s.theme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])
  return <AppShell />
}

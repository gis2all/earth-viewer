import { useEffect } from 'react'
import { Viewer, useCesium } from 'resium'
import { useAppStore } from '../state/store'
import { catalog } from '../layers/catalog'
import { baseLayerFor } from './providers'
import { LayerManager } from './LayerManager'

function ViewerBridge() {
  const { viewer } = useCesium()
  useEffect(() => {
    if (viewer) {
      ;(window as unknown as { __evViewer: typeof viewer }).__evViewer = viewer
    }
  }, [viewer])
  return null
}

export function GlobeViewer() {
  const activeBase = useAppStore((s) => s.activeBase)
  const base = catalog.find((l) => l.id === activeBase)

  return (
    <Viewer
      style={{ position: 'absolute', inset: 0 }}
      baseLayer={baseLayerFor(base)}
      baseLayerPicker={false}
      geocoder={false}
      homeButton={false}
      sceneModePicker={false}
      navigationHelpButton={false}
      fullscreenButton={false}
      animation={false}
      timeline={false}
      selectionIndicator={false}
      infoBox={false}
    >
      <ViewerBridge />
      <LayerManager />
    </Viewer>
  )
}

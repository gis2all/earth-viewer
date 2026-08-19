import * as Cesium from 'cesium'
import { Viewer } from 'resium'

const OSM_LAYER = new Cesium.ImageryLayer(
  new Cesium.UrlTemplateImageryProvider({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' })
)

export function GlobeViewer() {
  return (
    <Viewer
      style={{ position: 'absolute', inset: 0 }}
      baseLayer={OSM_LAYER}
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
    />
  )
}
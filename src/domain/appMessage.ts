/** 可跨 controller / globe / infra 传递的本地化消息描述。 */
export type AppMessageKey =
  | 'runtime.webglUnavailable'
  | 'runtime.webglContextLost'
  | 'runtime.globeInitFailed'
  | 'runtime.layerLoadFailed'
  | 'runtime.businessLimit'
  | 'runtime.globalSceneNote'
  | 'runtime.embeddedBudgetDegraded'
  | 'runtime.embeddedTooLarge'
  | 'runtime.pointCloudUnsupported'
  | 'runtime.embeddedEmpty'
  | 'runtime.embeddedLoadFailed'
  | 'runtime.sceneLoadFailed'
  | 'runtime.3dTilesLoadFailed'
  | 'runtime.budgetDegraded'
  | 'runtime.layersSkipped'
  | 'runtime.featuresPartial'
  | 'runtime.wfsLoadFailed'
  | 'runtime.csvLoadFailed'
  | 'runtime.geojsonTooLarge'
  | 'runtime.fileBudgetDegraded'
  | 'runtime.geojsonLoadFailed'
  | 'runtime.viewportBudgetDegraded'
  | 'runtime.featureLoadFailed'
  | 'runtime.kmlTooLarge'
  | 'runtime.kmlBudgetDegraded'
  | 'runtime.kmlLoadFailed'
  | 'runtime.vectorTileRenderFailed'
  | 'layer.loadFailedCheck'
  | 'layer.addedUnsupported'
  | 'layer.unsupportedDirectAdd'
  | 'layer.addFailed'

export interface AppMessage {
  key: AppMessageKey
  params?: Record<string, string | number>
}

import { processViewportData } from './viewportPipeline'
import type { ViewportProcessInput, ViewportProcessResult } from './viewportPipeline'

interface WorkerMessage {
  id: string
  input: ViewportProcessInput
}

// 数据管线在 Web Worker 中运行：解析 → 抽稀 → 顶点/要素预算，主线程不冻结。
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const { id, input } = e.data
  const result: ViewportProcessResult = processViewportData(input)
  ;(self as unknown as Worker).postMessage({ id, result })
}

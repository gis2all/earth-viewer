import { processViewportData, type ViewportProcessInput, type ViewportProcessResult } from './viewportPipeline'

/**
 * 在 Web Worker 中运行视口数据处理管线；jsdom/无 Worker 环境回退到同步（便于测试）。
 * 返回 { data, capped, vertices }（与 processViewportData 一致），主线程只等待结果，不解析大数据。
 */
export function runViewportProcess(input: ViewportProcessInput): Promise<ViewportProcessResult> {
  if (typeof Worker === 'undefined') return Promise.resolve(processViewportData(input))
  return new Promise((resolve) => {
    try {
      const w = new Worker(new URL('./viewportWorker.entry.ts', import.meta.url), { type: 'module' })
      const id = Math.random().toString(36).slice(2)
      w.onmessage = (e: MessageEvent<{ id: string; result: ViewportProcessResult }>) => {
        if (e.data?.id === id) {
          w.terminate()
          resolve(e.data.result)
        }
      }
      w.onerror = () => {
        w.terminate()
        resolve(processViewportData(input))
      }
      w.postMessage({ id, input })
    } catch {
      resolve(processViewportData(input))
    }
  })
}

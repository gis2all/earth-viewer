import { describe, expect, it, vi } from 'vitest'
import { detectBrowserLocale } from './locale'
import { translate, translateAppMessage } from './messages'
import { useAppStore } from '../app/store'

describe('i18n locale', () => {
  it('中文浏览器语言使用 zh-CN，其余使用 en', () => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['zh-TW'])
    expect(detectBrowserLocale()).toBe('zh-CN')

    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['ja-JP'])
    expect(detectBrowserLocale()).toBe('en')
    vi.restoreAllMocks()
  })

  it('翻译静态文案和运行时消息参数', () => {
    expect(translate('zh-CN', 'layer.viewItemDetail', { title: 'Imagery' })).toBe('查看 Imagery 详情')
    expect(translate('en', 'layer.viewItemDetail', { title: 'Imagery' })).toBe('View Imagery details')
    expect(translate('en', 'status.cameraHeight', { height: '22,000.31 km' })).toBe('Camera Height: 22,000.31 km')
    expect(translateAppMessage('en', { key: 'runtime.layerLoadFailed', params: { name: 'Map' } })).toBe('Layer failed to load: Map')
  })

  it('toggleLocale 在中英文之间切换', () => {
    useAppStore.setState({ locale: 'zh-CN' })
    useAppStore.getState().toggleLocale()
    expect(useAppStore.getState().locale).toBe('en')
    useAppStore.getState().toggleLocale()
    expect(useAppStore.getState().locale).toBe('zh-CN')
  })
})

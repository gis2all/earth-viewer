import { describe, expect, it } from 'vitest'
import { MESSAGE_KEYS, getMessageTemplate, translate } from './messages'

function placeholders(value: string): string[] {
  return Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort()
}

describe('i18n message catalogs', () => {
  it('keeps the added section title and action label distinct', () => {
    expect(translate('zh-CN', 'layer.added')).toBe('\u5df2\u6dfb\u52a0')
    expect(translate('zh-CN', 'layer.addedAction')).toBe('\u5df2\u6dfb\u52a0')
    expect(translate('en', 'layer.added')).toBe('Added Layers')
    expect(translate('en', 'layer.addedAction')).toBe('Added')
  })

  it('have matching non-empty keys and placeholders', () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThan(0)

    for (const key of MESSAGE_KEYS) {
      const zh = getMessageTemplate('zh-CN', key)
      const en = getMessageTemplate('en', key)
      expect(zh.trim(), key).not.toBe('')
      expect(en.trim(), key).not.toBe('')
      expect(placeholders(en), key).toEqual(placeholders(zh))
    }
  })
})

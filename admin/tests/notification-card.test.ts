// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { computed, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NotificationCard from '../app/components/NotificationCard.vue'
import zhCN from '../locales/zh-CN.json'

function translate(key: string): string {
  let value: unknown = zhCN
  for (const part of key.split('.')) {
    value = (value as Record<string, unknown>)[part]
  }
  return String(value)
}

describe('NotificationCard', () => {
  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('useI18n', () => ({
      t: translate,
      locale: ref('zh-CN'),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows source metadata and reveals title and body independently', async () => {
    const wrapper = mount(NotificationCard, {
      props: {
        notification: {
          id: 43,
          deviceId: 'phone-1',
          createdAt: 1_757_894_402_000,
          receivedAt: 1_757_894_403_000,
          eventType: 'POSTED',
          sourcePackage: 'com.example.bank',
          notificationId: 7,
          postedAt: 1_757_894_400_000,
          observedAt: 1_757_894_401_000,
          channelId: 'transactions',
          category: 'msg',
          title: '到账提醒',
          body: '收到人民币 88.00 元',
        },
      },
    })

    expect(wrapper.text()).toContain('com.example.bank')
    expect(wrapper.text()).not.toContain('到账提醒')
    expect(wrapper.findAll('.sensitive-value')).toHaveLength(2)

    await wrapper.findAll('.sensitive-value')[0].trigger('click')
    expect(wrapper.text()).toContain('到账提醒')
    expect(wrapper.text()).not.toContain('收到人民币 88.00 元')

    await wrapper.findAll('.sensitive-value')[1].trigger('click')
    expect(wrapper.text()).toContain('收到人民币 88.00 元')
  })

  it('responds to the global reveal control', async () => {
    const wrapper = mount(NotificationCard, {
      props: {
        revealAll: false,
        notification: {
          id: 44,
          deviceId: 'phone-1',
          createdAt: 1_757_894_402_000,
          receivedAt: 1_757_894_403_000,
          eventType: 'POSTED',
          sourcePackage: 'com.example.chat',
          notificationId: 8,
          postedAt: 1_757_894_400_000,
          observedAt: 1_757_894_401_000,
          channelId: null,
          category: null,
          title: 'Private title',
          body: 'Private body',
        },
      },
    })

    expect(wrapper.text()).not.toContain('Private body')
    await wrapper.setProps({ revealAll: true })
    expect(wrapper.text()).toContain('Private title')
    expect(wrapper.text()).toContain('Private body')
    await wrapper.setProps({ revealAll: false })
    expect(wrapper.text()).not.toContain('Private body')
  })
})

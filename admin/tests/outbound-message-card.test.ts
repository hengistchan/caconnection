// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OutboundMessageCard from '../app/components/OutboundMessageCard.vue'
import zhCN from '../locales/zh-CN.json'

function translate(key: string, params?: Record<string, unknown>): string {
  let value: unknown = zhCN
  for (const part of key.split('.')) {
    value = (value as Record<string, unknown>)[part]
  }
  return Object.entries(params || {}).reduce(
    (text, [name, replacement]) =>
      text.replace(`{${name}}`, String(replacement)),
    String(value),
  )
}

describe('OutboundMessageCard', () => {
  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useI18n', () => ({
      t: translate,
      locale: ref('zh-CN'),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('masks sensitive content until the user explicitly reveals it', async () => {
    const wrapper = mount(OutboundMessageCard, {
      props: {
        message: {
          id: 44,
          commandId: 'abcdefghijklmnop',
          deviceId: 'phone-1',
          slotIndex: 1,
          recipient: '+8613800000000',
          body: 'Private remote message',
          status: 'SENT_TO_MODEM',
          createdAt: 1_757_894_404_000,
          expiresAt: 1_757_894_704_000,
          claimedAt: 1_757_894_405_000,
          updatedAt: 1_757_894_406_000,
          lastResultCode: -1,
          errorDetail: null,
        },
      },
    })

    const reveal = wrapper.find('.outbound-header button')
    expect(reveal.attributes('aria-pressed')).toBe('false')
    expect(wrapper.text()).not.toContain('+8613800000000')
    expect(wrapper.text()).not.toContain('Private remote message')
    expect(wrapper.text()).toContain('已提交基带')

    await reveal.trigger('click')

    expect(reveal.attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('+8613800000000')
    expect(wrapper.text()).toContain('Private remote message')
  })

  it('renders terminal failure details without revealing message content', () => {
    const wrapper = mount(OutboundMessageCard, {
      props: {
        message: {
          id: 45,
          commandId: 'ponmlkjihgfedcba',
          deviceId: 'phone-1',
          slotIndex: 0,
          recipient: '10086',
          body: 'Private failed message',
          status: 'FAILED',
          createdAt: 1_757_894_404_000,
          expiresAt: 1_757_894_704_000,
          claimedAt: null,
          updatedAt: 1_757_894_406_000,
          lastResultCode: null,
          errorDetail: 'Requested SIM is not active',
        },
      },
    })

    expect(wrapper.find('.badge-danger').exists()).toBe(true)
    expect(wrapper.text()).toContain('Requested SIM is not active')
    expect(wrapper.text()).not.toContain('Private failed message')
  })
})

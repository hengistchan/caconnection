// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import {
  computed,
  nextTick,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MessageCard from '../app/components/MessageCard.vue'
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

describe('MessageCard', () => {
  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('nextTick', nextTick)
    vi.stubGlobal('onUnmounted', onUnmounted)
    vi.stubGlobal('useI18n', () => ({
      t: translate,
      locale: ref('zh-CN'),
    }))
    vi.stubGlobal('useGateway', () => ({
      claimOtp: vi.fn(),
    }))
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('renders string confidence and uses keyboard-native reveal controls', async () => {
    const wrapper = mount(MessageCard, {
      attachTo: document.body,
      props: {
        message: {
          id: 42,
          deviceId: 'phone-1',
          createdAt: 1_757_894_400_000,
          receivedAt: 1_757_894_401_000,
          subscriptionId: null,
          slotIndex: null,
          sender: '+8613800000000',
          body: '验证码 482913',
          partCount: 1,
          resolutionMethod: 'UNKNOWN',
          resolutionConfidence: 'LOW',
          otpCandidates: ['482913'],
        },
      },
    })

    expect(wrapper.text()).toContain('低')
    expect(wrapper.findAll('.sensitive-value')).toHaveLength(2)
    expect(wrapper.find('.sensitive-value').element.tagName).toBe('BUTTON')
    expect(wrapper.text()).not.toContain('+8613800000000')

    await wrapper.find('.sensitive-value').trigger('click')
    expect(wrapper.text()).toContain('+8613800000000')
  })

  it('reveals and hides all card content with one control', async () => {
    const wrapper = mount(MessageCard, {
      props: {
        message: {
          id: 44,
          deviceId: 'phone-1',
          createdAt: 1_757_894_400_000,
          receivedAt: 1_757_894_401_000,
          subscriptionId: 1,
          slotIndex: 0,
          sender: 'Service',
          body: 'Private content',
          partCount: 1,
          resolutionMethod: null,
          resolutionConfidence: null,
          otpCandidates: [],
        },
      },
    })

    await wrapper.find('.message-header .btn-ghost').trigger('click')
    expect(wrapper.text()).toContain('Service')
    expect(wrapper.text()).toContain('Private content')

    await wrapper.find('.message-header .btn-ghost').trigger('click')
    expect(wrapper.text()).not.toContain('Private content')
  })

  it('opens an accessible modal, focuses it, and closes on Escape', async () => {
    const wrapper = mount(MessageCard, {
      attachTo: document.body,
      props: {
        message: {
          id: 43,
          deviceId: 'phone-1',
          createdAt: 1_757_894_400_000,
          receivedAt: 1_757_894_401_000,
          subscriptionId: 1,
          slotIndex: 0,
          sender: 'Service',
          body: 'Code 482913',
          partCount: 1,
          resolutionMethod: 'SUBSCRIPTION_ID',
          resolutionConfidence: 'HIGH',
          otpCandidates: ['482913'],
        },
      },
    })

    await wrapper.find('.otp-heading .btn-primary').trigger('click')
    await nextTick()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.textContent).toContain('确认领取')

    dialog?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await nextTick()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

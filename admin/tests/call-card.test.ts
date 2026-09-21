// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CallCard from '../app/components/CallCard.vue'
import zhCN from '../locales/zh-CN.json'

function translate(key: string, params: Record<string, unknown> = {}): string {
  let value: unknown = zhCN
  for (const part of key.split('.')) {
    value = (value as Record<string, unknown>)[part]
  }
  return String(value).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
}

describe('CallCard', () => {
  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('useI18n', () => ({
      t: translate,
      locale: ref('zh-CN'),
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('masks caller identity and shows the aggregated call result', async () => {
    const wrapper = mount(CallCard, {
      props: {
        call: {
          id: 10,
          deviceId: 'phone-1',
          sessionId: 'session-1',
          createdAt: 100,
          receivedAt: 200,
          startedAt: 1_757_894_400_000,
          endedAt: 1_757_894_465_000,
          durationMillis: 60_000,
          subscriptionId: 1,
          slotIndex: 0,
          direction: 'INCOMING',
          state: 'IDLE',
          answered: true,
          states: [
            { state: 'RINGING', observedAt: 1_757_894_400_000, initialSnapshot: false },
            { state: 'OFFHOOK', observedAt: 1_757_894_405_000, initialSnapshot: false },
            { state: 'IDLE', observedAt: 1_757_894_465_000, initialSnapshot: false },
          ],
          callerAddress: '+8613800000000',
          callerDisplayName: '测试联系人',
          resolutionMethod: 'ACTIVE_CALL_STATE_CORRELATION',
          resolutionConfidence: 'MEDIUM',
          verificationStatus: 1,
          decision: 'ALLOW',
        },
      },
    })

    expect(wrapper.text()).toContain('已接听')
    expect(wrapper.text()).not.toContain('+8613800000000')
    await wrapper.findAll('.sensitive-value')[0].trigger('click')
    expect(wrapper.text()).toContain('+8613800000000')
  })
})

// @vitest-environment happy-dom

import { flushPromises, shallowMount } from '@vue/test-utils'
import {
  computed,
  nextTick,
  onMounted,
  ref,
} from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '../app/pages/login.vue'
import en from '../locales/en.json'

function translate(key: string): string {
  let value: unknown = en
  for (const part of key.split('.')) {
    value = (value as Record<string, unknown>)[part]
  }
  return String(value)
}

describe('TOTP login page', () => {
  const login = vi.fn()
  const verifyTotp = vi.fn()
  const navigateTo = vi.fn()

  beforeEach(() => {
    login.mockReset()
    verifyTotp.mockReset()
    navigateTo.mockReset()
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('nextTick', nextTick)
    vi.stubGlobal('onMounted', onMounted)
    vi.stubGlobal('useI18n', () => ({ t: translate }))
    vi.stubGlobal('useAuth', () => ({
      login,
      verifyTotp,
      isLoading: ref(false),
      checkSession: vi.fn().mockResolvedValue(false),
    }))
    vi.stubGlobal('navigateTo', navigateTo)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('moves from password to TOTP and authenticates with the challenge', async () => {
    login.mockResolvedValue({
      success: false,
      requiresTotp: true,
      challenge: 'challenge-token',
    })
    verifyTotp.mockResolvedValue({ success: true })
    const wrapper = shallowMount(LoginPage, {
      global: {
        stubs: { LanguageSwitcher: true },
      },
    })
    await flushPromises()

    await wrapper.get('#password').setValue('correct password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(login).toHaveBeenCalledWith('correct password')
    expect(wrapper.find('#totp-code').exists()).toBe(true)
    expect(wrapper.text()).toContain('Authentication code')

    await wrapper.get('#totp-code').setValue('123456')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(verifyTotp).toHaveBeenCalledWith('challenge-token', '123456')
    expect(navigateTo).toHaveBeenCalledWith('/')
  })
})

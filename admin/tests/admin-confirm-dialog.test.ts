// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminConfirmDialog from '../app/components/AdminConfirmDialog.vue'

describe('AdminConfirmDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('nextTick', nextTick)
    vi.stubGlobal('onUnmounted', onUnmounted)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('focuses the destructive action and closes on Escape', async () => {
    const wrapper = mount(AdminConfirmDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 'Delete device',
        message: 'This cannot be undone.',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        danger: true,
      },
    })
    await nextTick()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(document.activeElement?.textContent).toContain('Delete')

    dialog?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }))
    await nextTick()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})

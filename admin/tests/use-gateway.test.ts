import {
  computed,
  readonly,
  ref,
} from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGateway } from '../app/composables/useGateway'

describe('useGateway content loading', () => {
  const state = new Map<string, ReturnType<typeof ref>>()

  beforeEach(() => {
    state.clear()
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('readonly', readonly)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('useState', (key: string, factory: () => unknown) => {
      if (!state.has(key)) state.set(key, ref(factory()))
      return state.get(key)
    })
    vi.stubGlobal('useAuth', () => ({ csrfToken: ref('csrf-token') }))
    vi.stubGlobal('navigateTo', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps successful SMS data when notifications fail', async () => {
    const message = {
      id: 10,
      deviceId: 'phone-1',
      createdAt: 100,
      receivedAt: 101,
      subscriptionId: 1,
      slotIndex: 0,
      sender: 'Service',
      body: 'Message',
      partCount: 1,
      resolutionMethod: null,
      resolutionConfidence: null,
      otpCandidates: [],
    }
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages')) return { messages: [message] }
      throw { data: { message: 'Notifications unavailable' } }
    }))

    const gateway = useGateway()
    const [messagesOk, notificationsOk] = await Promise.all([
      gateway.fetchMessages({ limit: 50 }),
      gateway.fetchNotifications({ limit: 50 }),
    ])

    expect(messagesOk).toBe(true)
    expect(notificationsOk).toBe(false)
    expect(gateway.messages.value).toEqual([message])
    expect(gateway.messageError.value).toBeNull()
    expect(gateway.notificationError.value).toBe('Notifications unavailable')
  })

  it('appends older pages without duplicating records', async () => {
    const message = (id: number) => ({
      id,
      deviceId: 'phone-1',
      createdAt: id,
      receivedAt: id,
      subscriptionId: null,
      slotIndex: null,
      sender: null,
      body: null,
      partCount: 1,
      resolutionMethod: null,
      resolutionConfidence: null,
      otpCandidates: [],
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ messages: [message(3), message(2)] })
      .mockResolvedValueOnce({ messages: [message(2), message(1)] })
    vi.stubGlobal('$fetch', fetchMock)

    const gateway = useGateway()
    await gateway.fetchMessages({ limit: 2 })
    await gateway.fetchMessages({ limit: 2, beforeId: 2, append: true })

    expect(gateway.messages.value.map(item => item.id)).toEqual([3, 2, 1])
    expect(fetchMock.mock.calls[1][0]).toContain('beforeId=2')
  })

  it('forwards group filters without inventing a device filter', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/notifications')) return { notifications: [] }
      if (url.includes('/outbound-messages')) return { outboundMessages: [] }
      return { messages: [] }
    })
    vi.stubGlobal('$fetch', fetchMock)

    const gateway = useGateway()
    await gateway.fetchMessages({ limit: 50, groupId: 'primary' })
    await gateway.fetchNotifications({ limit: 50, groupId: 'primary' })
    await gateway.fetchOutboundMessages({ limit: 50, groupId: 'primary' })

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/admin/api/gateway/messages?limit=50&groupId=primary',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/admin/api/gateway/notifications?limit=50&groupId=primary',
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      '/admin/api/gateway/outbound-messages?limit=50&groupId=primary',
    )
  })

  it('protects Gateway group mutations with CSRF', async () => {
    const group = {
      groupId: 'primary',
      name: 'Primary',
      deviceIds: ['phone-1'],
      createdAt: 100,
      updatedAt: 100,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ groups: [group] })
      .mockResolvedValueOnce({ group })
      .mockResolvedValueOnce({ group: { ...group, name: 'Updated' } })
      .mockResolvedValueOnce({ deleted: true })
    vi.stubGlobal('$fetch', fetchMock)

    const gateway = useGateway()
    await expect(gateway.fetchDeviceGroups()).resolves.toEqual([group])
    await gateway.createDeviceGroup({
      groupId: 'primary',
      name: 'Primary',
      deviceIds: ['phone-1'],
    })
    await gateway.updateDeviceGroup('primary', { name: 'Updated' })
    await gateway.removeDeviceGroup('primary')

    expect(fetchMock.mock.calls[0][1]).toEqual({ credentials: 'include' })
    for (const callIndex of [1, 2, 3]) {
      expect(fetchMock.mock.calls[callIndex][1]).toEqual(
        expect.objectContaining({
          credentials: 'include',
          headers: { 'X-CSRF-Token': 'csrf-token' },
        }),
      )
    }
  })

  it('sends outbound messages with CSRF protection and default expiry', async () => {
    const outboundMessage = {
      id: 1,
      commandId: 'abcdefghijklmnop',
      deviceId: 'phone-1',
      slotIndex: 1,
      recipient: '10086',
      body: 'Remote message',
      status: 'QUEUED' as const,
      createdAt: 100,
      expiresAt: 300_100,
      claimedAt: null,
      updatedAt: 100,
      lastResultCode: null,
      errorDetail: null,
    }
    const fetchMock = vi.fn().mockResolvedValue({ outboundMessage })
    vi.stubGlobal('$fetch', fetchMock)

    const gateway = useGateway()
    await expect(gateway.sendOutboundMessage({
      deviceId: 'phone-1',
      slotIndex: 1,
      recipient: '10086',
      body: 'Remote message',
      idempotencyKey: 'admin-send-command-0001',
    })).resolves.toEqual(outboundMessage)

    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/api/gateway/outbound-messages',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': 'csrf-token' },
        body: {
          deviceId: 'phone-1',
          slotIndex: 1,
          recipient: '10086',
          body: 'Remote message',
          idempotencyKey: 'admin-send-command-0001',
          expiresInSeconds: 300,
        },
      }),
    )
  })
})

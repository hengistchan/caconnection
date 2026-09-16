import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimGatewayOtp,
  clearGatewayConfigForTests,
  createGatewayOutboundMessage,
  gatewayFetch,
  getGatewayMessages,
  getGatewayNotifications,
  getGatewayOutboundMessages,
} from '../server/utils/gateway'

const messageFixture = {
  id: 42,
  deviceId: 'phone-1',
  createdAt: 1_757_894_400_000,
  receivedAt: 1_757_894_401_000,
  subscriptionId: null,
  slotIndex: null,
  sender: '+8613800000000',
  body: 'Code 482913',
  partCount: 1,
  resolutionMethod: 'UNKNOWN',
  resolutionConfidence: 'LOW',
  otpCandidates: ['482913'],
}

const notificationFixture = {
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
  title: 'Payment received',
  body: 'You received CNY 88.00',
} as const

const outboundFixture = {
  id: 44,
  commandId: 'abcdefghijklmnop',
  deviceId: 'phone-1',
  slotIndex: 1,
  recipient: '10086',
  body: 'Remote message',
  status: 'QUEUED',
  createdAt: 1_757_894_404_000,
  expiresAt: 1_757_894_704_000,
  claimedAt: null,
  updatedAt: 1_757_894_404_000,
  lastResultCode: null,
  errorDetail: null,
}

describe('Gateway BFF client', () => {
  beforeEach(() => {
    process.env.GATEWAY_URL = 'http://gateway.test'
    process.env.ADMIN_API_TOKEN = 'test-token'
    process.env.ADMIN_API_TOKEN_FILE = '/does/not/exist'
    clearGatewayConfigForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearGatewayConfigForTests()
  })

  it('accepts the real string confidence response shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [messageFixture] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))
    await expect(getGatewayMessages()).resolves.toEqual({
      messages: [messageFixture],
    })
  })

  it('accepts notification title and body fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ notifications: [notificationFixture] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))
    await expect(getGatewayNotifications()).resolves.toEqual({
      notifications: [notificationFixture],
    })
  })

  it('forwards older-page cursors for message and notification queries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ notifications: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await getGatewayMessages({ limit: 25, beforeId: 40 })
    await getGatewayNotifications({ limit: 50, beforeId: 80 })

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway.test/v1/messages?limit=25&beforeId=40',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://gateway.test/v1/notifications?limit=50&beforeId=80',
    )
  })

  it('validates and forwards remote outbound messages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        outboundMessages: [outboundFixture],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        outboundMessage: outboundFixture,
      }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGatewayOutboundMessages({
      limit: 25,
      beforeId: 50,
      deviceId: 'phone-1',
    })).resolves.toEqual({ outboundMessages: [outboundFixture] })
    await expect(createGatewayOutboundMessage({
      deviceId: 'phone-1',
      slotIndex: 1,
      recipient: '10086',
      body: 'Remote message',
      expiresInSeconds: 300,
      idempotencyKey: 'admin-send-command-0001',
    })).resolves.toEqual({ outboundMessage: outboundFixture })

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://gateway.test/v1/outbound-messages?limit=25&beforeId=50&deviceId=phone-1',
    )
    const request = fetchMock.mock.calls[1][1] as RequestInit
    expect(request.method).toBe('POST')
    expect(JSON.parse(request.body as string)).toMatchObject({
      deviceId: 'phone-1',
      slotIndex: 1,
      recipient: '10086',
    })
  })

  it('omits unknown slotIndex from exact-event OTP claims', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        otp: {
          eventId: 42,
          deviceId: 'phone-1',
          receivedAt: 1_757_894_401_000,
          subscriptionId: null,
          slotIndex: null,
          code: '482913',
          expiresAt: 1_757_895_000_000,
        },
      }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await claimGatewayOtp({ eventId: 42, maxAgeSeconds: 600 })
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(request.body as string)).toEqual({
      eventId: 42,
      maxAgeSeconds: 600,
    })
  })

  it.each([400, 401, 403, 404, 409, 410, 429, 503])(
    'preserves safe Gateway status %i without exposing response text',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('sensitive upstream details', {
          status,
          headers: status === 429 ? { 'retry-after': '120' } : {},
        }),
      ))
      await expect(gatewayFetch('/v1/test')).rejects.toMatchObject({
        statusCode: status,
        message: expect.not.stringContaining('sensitive upstream details'),
        ...(status === 429 ? { data: { retryAfter: '120' } } : {}),
      })
    },
  )

  it('maps unexpected Gateway failures to 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('failure', { status: 418 }),
    ))
    await expect(gatewayFetch('/v1/test')).rejects.toMatchObject({
      statusCode: 502,
      message: 'Gateway service unavailable',
    })
  })

  it('rejects malformed response shapes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        messages: [{ ...messageFixture, resolutionConfidence: 0.9 }],
      }), { status: 200 }),
    ))
    await expect(getGatewayMessages()).rejects.toMatchObject({
      statusCode: 502,
    })
  })

  it('rejects malformed notification content fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        notifications: [{ ...notificationFixture, title: 123 }],
      }), { status: 200 }),
    ))
    await expect(getGatewayNotifications()).rejects.toMatchObject({
      statusCode: 502,
    })
  })

  it.each([
    'file:///tmp/gateway',
    'https://user:pass@gateway.test',
    'https://gateway.test/path',
  ])('rejects unsafe Gateway URL %s', async (url) => {
    process.env.GATEWAY_URL = url
    clearGatewayConfigForTests()
    await expect(gatewayFetch('/health')).rejects.toMatchObject({
      statusCode: 500,
    })
  })
})

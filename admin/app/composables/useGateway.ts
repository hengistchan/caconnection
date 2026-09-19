export interface GatewayStatus {
  health: { status: string; ok: boolean }
  ready: { status: string; ok: boolean }
  version: {
    service: string
    version: string
    apiVersion: number
    protocolSchemaVersion: number
  } | null
  timestamp: number
}

export interface GatewayMessage {
  id: number
  deviceId: string
  createdAt: number
  receivedAt: number
  subscriptionId: number | null
  slotIndex: number | null
  sender: string | null
  body: string | null
  partCount: number | null
  resolutionMethod: string | null
  resolutionConfidence: string | null
  otpCandidates: string[]
}

export interface GatewayNotification {
  id: number
  deviceId: string
  createdAt: number
  receivedAt: number
  eventType: 'POSTED' | 'REMOVED' | null
  sourcePackage: string | null
  notificationId: number | null
  postedAt: number | null
  observedAt: number | null
  channelId: string | null
  category: string | null
  title: string | null
  body: string | null
}

export interface OtpClaimResult {
  otp: {
    eventId: number
    deviceId: string
    receivedAt: number
    subscriptionId: number | null
    slotIndex: number | null
    code: string
    expiresAt: number
  }
}

export interface PairingResult {
  pairing: {
    deviceId: string
    expiresAt: number
    payload: string
  }
}

export interface GatewayDeviceDetail {
  deviceId: string
  description: string
  createdAt: number
  lastSeenAt: number | null
  retiredAt: number | null
  health: 'ONLINE' | 'STALE' | 'OFFLINE' | 'NEVER' | 'RETIRED'
  status: {
    observedAt: number | null
    appVersion: string | null
    versionCode: number | null
    targetSdk: number | null
    androidVersion: string | null
    manufacturer: string | null
    model: string | null
    receiveMode: 'OBSERVER' | 'DEFAULT_SMS' | null
    defaultSmsRole: boolean | null
    permissions: {
      receiveSms: boolean | null
      sendSms: boolean | null
      readPhoneState: boolean | null
    }
    lastIncomingSmsAt: number | null
    lastOtpAt: number | null
    lastOrdinarySmsAt: number | null
    lastReceiverAction: 'SMS_RECEIVED' | 'SMS_DELIVER' | null
    lastReceiverActionAt: number | null
    lastReceiverInvokedAt: number | null
    lastReceiverInvokedAction: 'SMS_RECEIVED' | 'SMS_DELIVER' | null
    lastReceiverParseFailureAt: number | null
    lastReceiverParseFailureReason:
      | 'NO_MESSAGES'
      | 'PARSER_EXCEPTION'
      | 'PROCESSING_EXCEPTION'
      | null
    lines: Array<{
      slotIndex: number
      subscriptionId: number | null
      carrierName: string | null
      displayName: string | null
      active: boolean
      observedAt: number
    }>
  }
}

export type GatewayOutboundStatus =
  | 'QUEUED'
  | 'CLAIMED'
  | 'CREATED'
  | 'DISPATCHING'
  | 'SENT_TO_MODEM'
  | 'DELIVERED'
  | 'FAILED'
  | 'EXPIRED'

export interface GatewayOutboundMessage {
  id: number
  commandId: string
  deviceId: string
  slotIndex: number
  recipient: string
  body: string
  status: GatewayOutboundStatus
  createdAt: number
  expiresAt: number
  claimedAt: number | null
  updatedAt: number
  lastResultCode: number | null
  errorDetail: string | null
}

export interface GatewayAuditEntry {
  id: number
  occurredAt: number
  clientId: string
  action: string
  deviceId: string | null
  outcome: string
  metadata: Record<string, unknown>
}

export interface GatewayNotificationSettings {
  channel: 'FEISHU'
  configured: boolean
  signingEnabled: boolean
  enabled: boolean
  contentMode: 'REDACTED' | 'FULL'
  updatedAt: number
  pendingCount: number
  retryCount: number
  lastSuccessAt: number | null
  lastAttemptAt: number | null
}

export interface GatewayDeviceGroup {
  groupId: string
  name: string
  deviceIds: string[]
  createdAt: number
  updatedAt: number
}

export function useGateway() {
  const { csrfToken } = useAuth()
  const status = useState<GatewayStatus | null>('gateway-status', () => null)
  const messages = useState<GatewayMessage[]>('gateway-messages', () => [])
  const notifications = useState<GatewayNotification[]>(
    'gateway-notifications',
    () => [],
  )
  const outboundMessages = useState<GatewayOutboundMessage[]>(
    'gateway-outbound-messages',
    () => [],
  )
  const statusLoading = useState<boolean>('gateway-status-loading', () => false)
  const messageLoading = useState<boolean>('gateway-message-loading', () => false)
  const notificationLoading = useState<boolean>(
    'gateway-notification-loading',
    () => false,
  )
  const outboundLoading = useState<boolean>(
    'gateway-outbound-loading',
    () => false,
  )
  const outboundError = useState<string | null>(
    'gateway-outbound-error',
    () => null,
  )
  const outboundHasMore = useState<boolean>(
    'gateway-outbound-has-more',
    () => true,
  )
  const messageHasMore = useState<boolean>('gateway-message-has-more', () => true)
  const notificationHasMore = useState<boolean>(
    'gateway-notification-has-more',
    () => true,
  )
  const statusLastSuccessAt = useState<number | null>(
    'gateway-status-last-success-at',
    () => null,
  )
  const messageLastSuccessAt = useState<number | null>(
    'gateway-message-last-success-at',
    () => null,
  )
  const notificationLastSuccessAt = useState<number | null>(
    'gateway-notification-last-success-at',
    () => null,
  )
  const statusError = useState<string | null>('gateway-status-error', () => null)
  const messageError = useState<string | null>('gateway-message-error', () => null)
  const notificationError = useState<string | null>(
    'gateway-notification-error',
    () => null,
  )

  /**
   * Fetch gateway status
   */
  async function fetchStatus(): Promise<boolean> {
    statusLoading.value = true
    try {
      const data = await $fetch<GatewayStatus>('/admin/api/gateway/status', {
        credentials: 'include',
      })
      status.value = data
      statusError.value = null
      statusLastSuccessAt.value = Date.now()
      return true
    } catch (err: unknown) {
      const fetchError = err as { statusCode?: number; data?: { message?: string } }
      if (fetchError.statusCode === 401) {
        navigateTo('/login')
      }
      statusError.value = fetchError.data?.message || 'Failed to fetch status'
      return false
    } finally {
      statusLoading.value = false
    }
  }

  /**
   * Fetch messages
   */
  async function fetchMessages(options: {
    limit?: number
    slotIndex?: number | null
    beforeId?: number | null
    append?: boolean
    deviceId?: string
    groupId?: string
  } = {}): Promise<boolean> {
    messageLoading.value = true

    try {
      const params = new URLSearchParams()
      if (options.limit) {
        params.set('limit', options.limit.toString())
      }
      if (options.slotIndex !== undefined && options.slotIndex !== null) {
        params.set('slotIndex', options.slotIndex.toString())
      }
      if (options.beforeId !== undefined && options.beforeId !== null) {
        params.set('beforeId', options.beforeId.toString())
      }
      if (options.deviceId) params.set('deviceId', options.deviceId)
      if (options.groupId) params.set('groupId', options.groupId)

      const query = params.toString()
      const url = `/admin/api/gateway/messages${query ? `?${query}` : ''}`

      const data = await $fetch<{ messages: GatewayMessage[] }>(url, {
        credentials: 'include',
      })

      if (options.append) {
        const merged = new Map(messages.value.map(message => [message.id, message]))
        data.messages.forEach(message => merged.set(message.id, message))
        messages.value = [...merged.values()].sort((left, right) => right.id - left.id)
      } else {
        messages.value = data.messages
      }
      messageHasMore.value = data.messages.length === (options.limit ?? 50)
      messageError.value = null
      messageLastSuccessAt.value = Date.now()
      return true
    } catch (err: unknown) {
      const fetchError = err as { statusCode?: number; data?: { message?: string } }
      if (fetchError.statusCode === 401) {
        navigateTo('/login')
      }
      messageError.value = fetchError.data?.message || 'Failed to fetch messages'
      return false
    } finally {
      messageLoading.value = false
    }
  }

  async function fetchNotifications(options: {
    limit?: number
    beforeId?: number | null
    append?: boolean
    deviceId?: string
    groupId?: string
  } = {}): Promise<boolean> {
    notificationLoading.value = true

    try {
      const params = new URLSearchParams()
      if (options.limit) {
        params.set('limit', options.limit.toString())
      }
      if (options.beforeId !== undefined && options.beforeId !== null) {
        params.set('beforeId', options.beforeId.toString())
      }
      if (options.deviceId) params.set('deviceId', options.deviceId)
      if (options.groupId) params.set('groupId', options.groupId)
      const query = params.toString()
      const url = `/admin/api/gateway/notifications${query ? `?${query}` : ''}`
      const data = await $fetch<{ notifications: GatewayNotification[] }>(url, {
        credentials: 'include',
      })

      if (options.append) {
        const merged = new Map(
          notifications.value.map(notification => [notification.id, notification]),
        )
        data.notifications.forEach(notification =>
          merged.set(notification.id, notification))
        notifications.value = [...merged.values()]
          .sort((left, right) => right.id - left.id)
      } else {
        notifications.value = data.notifications
      }
      notificationHasMore.value
        = data.notifications.length === (options.limit ?? 50)
      notificationError.value = null
      notificationLastSuccessAt.value = Date.now()
      return true
    } catch (err: unknown) {
      const fetchError = err as { statusCode?: number; data?: { message?: string } }
      if (fetchError.statusCode === 401) {
        navigateTo('/login')
      }
      notificationError.value
        = fetchError.data?.message || 'Failed to fetch notifications'
      return false
    } finally {
      notificationLoading.value = false
    }
  }

  async function fetchOutboundMessages(options: {
    limit?: number
    beforeId?: number | null
    deviceId?: string
    groupId?: string
    append?: boolean
  } = {}): Promise<boolean> {
    outboundLoading.value = true
    try {
      const params = new URLSearchParams()
      if (options.limit) params.set('limit', options.limit.toString())
      if (options.beforeId !== undefined && options.beforeId !== null) {
        params.set('beforeId', options.beforeId.toString())
      }
      if (options.deviceId) params.set('deviceId', options.deviceId)
      if (options.groupId) params.set('groupId', options.groupId)
      const query = params.toString()
      const data = await $fetch<{ outboundMessages: GatewayOutboundMessage[] }>(
        `/admin/api/gateway/outbound-messages${query ? `?${query}` : ''}`,
        { credentials: 'include' },
      )
      if (options.append) {
        const merged = new Map(
          outboundMessages.value.map(message => [message.id, message]),
        )
        data.outboundMessages.forEach(message => merged.set(message.id, message))
        outboundMessages.value = [...merged.values()]
          .sort((left, right) => right.id - left.id)
      } else {
        outboundMessages.value = data.outboundMessages
      }
      outboundHasMore.value
        = data.outboundMessages.length === (options.limit ?? 50)
      outboundError.value = null
      return true
    } catch (err: unknown) {
      const fetchError = err as { statusCode?: number; data?: { message?: string } }
      if (fetchError.statusCode === 401) navigateTo('/login')
      outboundError.value
        = fetchError.data?.message || 'Failed to fetch outbound messages'
      return false
    } finally {
      outboundLoading.value = false
    }
  }

  async function sendOutboundMessage(options: {
    deviceId: string
    slotIndex: number
    recipient: string
    body: string
    expiresInSeconds?: number
    idempotencyKey: string
  }): Promise<GatewayOutboundMessage> {
    const data = await $fetch<{ outboundMessage: GatewayOutboundMessage }>(
      '/admin/api/gateway/outbound-messages',
      {
        method: 'POST',
        body: {
          ...options,
          expiresInSeconds: options.expiresInSeconds ?? 300,
        },
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
    return data.outboundMessage
  }

  /**
   * Claim OTP
   */
  async function claimOtp(options: {
    eventId: number
    deviceId?: string
    slotIndex?: number
    maxAgeSeconds?: number
  }): Promise<OtpClaimResult | null> {
    try {
      const data = await $fetch<OtpClaimResult>('/admin/api/gateway/otp/claim', {
        method: 'POST',
        body: {
          eventId: options.eventId,
          ...(options.deviceId ? { deviceId: options.deviceId } : {}),
          ...(options.slotIndex !== undefined
            ? { slotIndex: options.slotIndex }
            : {}),
          maxAgeSeconds: options.maxAgeSeconds ?? 600,
        },
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      })

      return data
    } catch (err: unknown) {
      const fetchError = err as { statusCode?: number; data?: { message?: string } }

      if (fetchError.statusCode === 401) {
        navigateTo('/login')
        return null
      }

      throw Object.assign(
        new Error(fetchError.data?.message || 'Failed to claim OTP'),
        { statusCode: fetchError.statusCode },
      )
    }
  }

  async function fetchDevices(): Promise<string[]> {
    const data = await $fetch<{ devices: string[] }>('/admin/api/gateway/devices', {
      credentials: 'include',
    })
    return data.devices
  }

  async function createPairing(options: {
    deviceId: string
    expiresInSeconds?: number
  }): Promise<PairingResult> {
    return await $fetch<PairingResult>('/admin/api/gateway/pairings', {
      method: 'POST',
      body: {
        deviceId: options.deviceId,
        expiresInSeconds: options.expiresInSeconds ?? 300,
      },
      headers: csrfToken.value
        ? { 'X-CSRF-Token': csrfToken.value }
        : undefined,
      credentials: 'include',
    })
  }

  async function fetchDeviceDetails(): Promise<GatewayDeviceDetail[]> {
    const data = await $fetch<{ devices: GatewayDeviceDetail[] }>('/admin/api/gateway/devices/detail', {
      credentials: 'include',
    })
    return data.devices
  }

  async function addDevice(options: {
    deviceId: string
    secretBase64: string
    description?: string
  }): Promise<GatewayDeviceDetail> {
    const data = await $fetch<{ device: GatewayDeviceDetail }>('/admin/api/gateway/devices', {
      method: 'POST',
      body: options,
      headers: csrfToken.value
        ? { 'X-CSRF-Token': csrfToken.value }
        : undefined,
      credentials: 'include',
    })
    return data.device
  }

  async function updateDevice(
    deviceId: string,
    options: { description?: string; secretBase64?: string },
  ): Promise<GatewayDeviceDetail> {
    const data = await $fetch<{ device: GatewayDeviceDetail }>(
      `/admin/api/gateway/devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'PUT',
        body: options,
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
    return data.device
  }

  async function removeDevice(deviceId: string): Promise<void> {
    await $fetch(`/admin/api/gateway/devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
  }

  async function restoreDevice(deviceId: string): Promise<void> {
    await $fetch(
      `/admin/api/gateway/devices/${encodeURIComponent(deviceId)}/restore`,
      {
        method: 'POST',
        body: {},
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
  }

  async function purgeDevice(deviceId: string): Promise<void> {
    await $fetch(
      `/admin/api/gateway/devices/${encodeURIComponent(deviceId)}/purge`,
      {
        method: 'POST',
        body: { confirmation: `PURGE ${deviceId}` },
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
  }

  async function fetchAuditLog(): Promise<GatewayAuditEntry[]> {
    const data = await $fetch<{ entries: GatewayAuditEntry[] }>(
      '/admin/api/gateway/audit-log',
      { credentials: 'include' },
    )
    return data.entries
  }

  async function fetchNotificationSettings(): Promise<GatewayNotificationSettings> {
    const data = await $fetch<{ settings: GatewayNotificationSettings }>(
      '/admin/api/gateway/notification-settings',
      { credentials: 'include' },
    )
    return data.settings
  }

  async function updateNotificationSettings(options: {
    enabled: boolean
    contentMode: 'REDACTED' | 'FULL'
  }): Promise<GatewayNotificationSettings> {
    const data = await $fetch<{ settings: GatewayNotificationSettings }>(
      '/admin/api/gateway/notification-settings',
      {
        method: 'PUT',
        body: options,
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
    return data.settings
  }

  async function testNotification(): Promise<void> {
    await $fetch('/admin/api/gateway/notification-settings/test', {
      method: 'POST',
      body: {},
      headers: csrfToken.value
        ? { 'X-CSRF-Token': csrfToken.value }
        : undefined,
      credentials: 'include',
    })
  }

  async function fetchDeviceGroups(): Promise<GatewayDeviceGroup[]> {
    const data = await $fetch<{ groups: GatewayDeviceGroup[] }>(
      '/admin/api/gateway/device-groups',
      { credentials: 'include' },
    )
    return data.groups
  }

  async function createDeviceGroup(options: {
    groupId: string
    name: string
    deviceIds: string[]
  }): Promise<void> {
    await $fetch('/admin/api/gateway/device-groups', {
      method: 'POST',
      body: options,
      headers: csrfToken.value
        ? { 'X-CSRF-Token': csrfToken.value }
        : undefined,
      credentials: 'include',
    })
  }

  async function updateDeviceGroup(
    groupId: string,
    options: { name?: string; deviceIds?: string[] },
  ): Promise<void> {
    await $fetch(
      `/admin/api/gateway/device-groups/${encodeURIComponent(groupId)}`,
      {
        method: 'PUT',
        body: options,
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
  }

  async function removeDeviceGroup(groupId: string): Promise<void> {
    await $fetch(
      `/admin/api/gateway/device-groups/${encodeURIComponent(groupId)}`,
      {
        method: 'DELETE',
        headers: csrfToken.value
          ? { 'X-CSRF-Token': csrfToken.value }
          : undefined,
        credentials: 'include',
      },
    )
  }

  /**
   * Calculate message counts by SIM slot
   */
  const simCounts = computed(() => {
    const counts = { sim1: 0, sim2: 0 }
    for (const msg of messages.value) {
      if (msg.slotIndex === 0) counts.sim1++
      else if (msg.slotIndex === 1) counts.sim2++
    }
    return counts
  })

  /**
   * Get latest message timestamp
   */
  const latestMessageTime = computed(() => {
    if (messages.value.length === 0) return null
    return Math.max(...messages.value.map(m => m.receivedAt))
  })

  return {
    status: readonly(status),
    messages: readonly(messages),
    notifications: readonly(notifications),
    outboundMessages: readonly(outboundMessages),
    isLoading: computed(() =>
      messageLoading.value || notificationLoading.value),
    statusLoading: readonly(statusLoading),
    messageLoading: readonly(messageLoading),
    notificationLoading: readonly(notificationLoading),
    outboundLoading: readonly(outboundLoading),
    messageHasMore: readonly(messageHasMore),
    notificationHasMore: readonly(notificationHasMore),
    outboundHasMore: readonly(outboundHasMore),
    statusLastSuccessAt: readonly(statusLastSuccessAt),
    messageLastSuccessAt: readonly(messageLastSuccessAt),
    notificationLastSuccessAt: readonly(notificationLastSuccessAt),
    error: computed(() =>
      statusError.value || messageError.value || notificationError.value),
    statusError: readonly(statusError),
    messageError: readonly(messageError),
    notificationError: readonly(notificationError),
    outboundError: readonly(outboundError),
    simCounts,
    latestMessageTime,
    fetchStatus,
    fetchMessages,
    fetchNotifications,
    fetchOutboundMessages,
    sendOutboundMessage,
    claimOtp,
    fetchDevices,
    createPairing,
    fetchDeviceDetails,
    addDevice,
    updateDevice,
    removeDevice,
    restoreDevice,
    purgeDevice,
    fetchAuditLog,
    fetchNotificationSettings,
    updateNotificationSettings,
    testNotification,
    fetchDeviceGroups,
    createDeviceGroup,
    updateDeviceGroup,
    removeDeviceGroup,
  }
}

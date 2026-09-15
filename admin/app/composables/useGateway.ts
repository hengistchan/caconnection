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

export function useGateway() {
  const { csrfToken } = useAuth()
  const status = useState<GatewayStatus | null>('gateway-status', () => null)
  const messages = useState<GatewayMessage[]>('gateway-messages', () => [])
  const isLoading = useState<boolean>('gateway-loading', () => false)
  const error = useState<string | null>('gateway-error', () => null)

  /**
   * Fetch gateway status
   */
  async function fetchStatus(): Promise<void> {
    try {
      const data = await $fetch<GatewayStatus>('/admin/api/gateway/status', {
        credentials: 'include',
      })
      status.value = data
      error.value = null
    } catch (err: unknown) {
      const fetchError = err as { statusCode?: number; data?: { message?: string } }
      if (fetchError.statusCode === 401) {
        navigateTo('/login')
      }
      error.value = fetchError.data?.message || 'Failed to fetch status'
    }
  }

  /**
   * Fetch messages
   */
  async function fetchMessages(options: {
    limit?: number
    slotIndex?: number | null
  } = {}): Promise<void> {
    isLoading.value = true

    try {
      const params = new URLSearchParams()
      if (options.limit) {
        params.set('limit', options.limit.toString())
      }
      if (options.slotIndex !== undefined && options.slotIndex !== null) {
        params.set('slotIndex', options.slotIndex.toString())
      }

      const query = params.toString()
      const url = `/admin/api/gateway/messages${query ? `?${query}` : ''}`

      const data = await $fetch<{ messages: GatewayMessage[] }>(url, {
        credentials: 'include',
      })

      messages.value = data.messages
      error.value = null
    } catch (err: unknown) {
      const fetchError = err as { statusCode?: number; data?: { message?: string } }
      if (fetchError.statusCode === 401) {
        navigateTo('/login')
      }
      error.value = fetchError.data?.message || 'Failed to fetch messages'
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Claim OTP
   */
  async function claimOtp(options: {
    eventId: number
    slotIndex?: number
    maxAgeSeconds?: number
  }): Promise<OtpClaimResult | null> {
    try {
      const data = await $fetch<OtpClaimResult>('/admin/api/gateway/otp/claim', {
        method: 'POST',
        body: {
          eventId: options.eventId,
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
    isLoading: readonly(isLoading),
    error: readonly(error),
    simCounts,
    latestMessageTime,
    fetchStatus,
    fetchMessages,
    claimOtp,
    fetchDevices,
    createPairing,
  }
}

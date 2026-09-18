import { readFileSync } from 'node:fs'
import type { H3Event } from 'h3'
import { createError, setResponseHeader } from 'h3'

let gatewayConfig: {
  token: string
  baseUrl: string
} | null = null

const FORWARDED_STATUS_CODES = new Set([400, 401, 403, 404, 409, 410, 429, 503])

interface GatewayErrorData {
  retryAfter?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value))
}

function invalidGatewayResponse(): never {
  throw createError({
    statusCode: 502,
    message: 'Gateway returned an invalid response',
  })
}

function parseBaseUrl(rawValue: string): string {
  try {
    const value = new URL(rawValue)
    if (
      !['http:', 'https:'].includes(value.protocol)
      || value.username
      || value.password
      || value.pathname !== '/'
      || value.search
      || value.hash
    ) {
      throw new Error('invalid gateway origin')
    }
    return value.origin
  } catch {
    throw createError({
      statusCode: 500,
      message: 'Invalid Gateway URL configuration',
    })
  }
}

function loadGatewayConfig(): { token: string; baseUrl: string } {
  if (gatewayConfig) return gatewayConfig

  let token: string
  const baseUrl = parseBaseUrl(process.env.GATEWAY_URL || 'http://gateway:8787')
  const secretPath = process.env.ADMIN_API_TOKEN_FILE || '/run/secrets/admin_api_token'
  try {
    token = readFileSync(secretPath, 'utf-8').trim()
  } catch {
    token = process.env.ADMIN_API_TOKEN || ''
  }

  if (!token) {
    throw createError({
      statusCode: 500,
      message: 'Gateway API token not configured',
    })
  }

  gatewayConfig = { token, baseUrl }
  return gatewayConfig
}

function safeRetryAfter(value: string | null): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return /^\d{1,6}$/.test(trimmed) ? trimmed : undefined
}

function gatewayErrorMessage(status: number): string {
  switch (status) {
    case 400: return 'Gateway rejected the request'
    case 401: return 'Gateway authentication failed'
    case 403: return 'Gateway denied the request'
    case 404: return 'Gateway resource was not found'
    case 409: return 'Gateway resource already exists'
    case 410: return 'Gateway resource is no longer available'
    case 429: return 'Gateway rate limit exceeded'
    case 503: return 'Gateway service is not ready'
    default: return 'Gateway service unavailable'
  }
}

export async function gatewayFetch(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: Record<string, unknown>
    timeout?: number
  } = {},
): Promise<unknown> {
  const { token, baseUrl } = loadGatewayConfig()
  const { method = 'GET', body, timeout = 10_000 } = options
  if (!path.startsWith('/')) {
    throw createError({ statusCode: 500, message: 'Invalid Gateway API path' })
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeout),
  }
  if (body && (method === 'POST' || method === 'PUT')) {
    headers['Content-Type'] = 'application/json'
    fetchOptions.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, fetchOptions)
    if (!response.ok) {
      const statusCode = FORWARDED_STATUS_CODES.has(response.status)
        ? response.status
        : 502
      throw createError<GatewayErrorData>({
        statusCode,
        message: gatewayErrorMessage(response.status),
        data: {
          retryAfter: statusCode === 429
            ? safeRetryAfter(response.headers.get('retry-after'))
            : undefined,
        },
      })
    }
    return await response.json()
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({
      statusCode: 502,
      message: 'Gateway service unavailable',
    })
  }
}

export function applyGatewayErrorHeaders(event: H3Event, error: unknown): void {
  if (!error || typeof error !== 'object' || !('data' in error)) return
  const data = (error as { data?: GatewayErrorData }).data
  if (data?.retryAfter) {
    setResponseHeader(event, 'Retry-After', data.retryAfter)
  }
}

export interface GatewayHealthResponse {
  status: string
}

export interface GatewayVersionResponse {
  service: string
  version: string
  apiVersion: number
  protocolSchemaVersion: number
}

export interface GatewayReadyResponse {
  status: string
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

export interface GatewayMessagesResponse {
  messages: GatewayMessage[]
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

export interface GatewayNotificationsResponse {
  notifications: GatewayNotification[]
}

export interface GatewayOtpClaimResponse {
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

export interface GatewayDevicesResponse {
  devices: string[]
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

export interface GatewayDeviceDetailResponse {
  devices: GatewayDeviceDetail[]
}

export interface GatewayDeviceResponse {
  device: GatewayDeviceDetail
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

export interface GatewayDeviceGroup {
  groupId: string
  name: string
  deviceIds: string[]
  createdAt: number
  updatedAt: number
}

export interface GatewayPairingResponse {
  pairing: {
    deviceId: string
    expiresAt: number
    payload: string
  }
}

export interface GatewayOutboundMessage {
  id: number
  commandId: string
  deviceId: string
  slotIndex: number
  recipient: string
  body: string
  status:
    | 'QUEUED'
    | 'CLAIMED'
    | 'CREATED'
    | 'DISPATCHING'
    | 'SENT_TO_MODEM'
    | 'DELIVERED'
    | 'FAILED'
    | 'EXPIRED'
  createdAt: number
  expiresAt: number
  claimedAt: number | null
  updatedAt: number
  lastResultCode: number | null
  errorDetail: string | null
}

export interface GatewayOutboundMessagesResponse {
  outboundMessages: GatewayOutboundMessage[]
}

export interface GatewayOutboundMessageResponse {
  outboundMessage: GatewayOutboundMessage
}

function parseStatusResponse(value: unknown): GatewayHealthResponse {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return invalidGatewayResponse()
  }
  return { status: value.status }
}

function parseVersionResponse(value: unknown): GatewayVersionResponse {
  if (
    !isRecord(value)
    || typeof value.service !== 'string'
    || typeof value.version !== 'string'
    || typeof value.apiVersion !== 'number'
    || !Number.isSafeInteger(value.apiVersion)
    || typeof value.protocolSchemaVersion !== 'number'
    || !Number.isSafeInteger(value.protocolSchemaVersion)
  ) {
    return invalidGatewayResponse()
  }
  return value as unknown as GatewayVersionResponse
}

function parseMessage(value: unknown): GatewayMessage {
  if (
    !isRecord(value)
    || typeof value.id !== 'number'
    || !Number.isSafeInteger(value.id)
    || typeof value.deviceId !== 'string'
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || typeof value.receivedAt !== 'number'
    || !Number.isSafeInteger(value.receivedAt)
    || !isNullableInteger(value.subscriptionId)
    || !isNullableInteger(value.slotIndex)
    || !(value.sender === null || typeof value.sender === 'string')
    || !(value.body === null || typeof value.body === 'string')
    || !isNullableInteger(value.partCount)
    || !(value.resolutionMethod === null || typeof value.resolutionMethod === 'string')
    || !(value.resolutionConfidence === null || typeof value.resolutionConfidence === 'string')
    || !Array.isArray(value.otpCandidates)
    || !value.otpCandidates.every(candidate =>
      typeof candidate === 'string' && /^[0-9]{4,8}$/.test(candidate))
  ) {
    return invalidGatewayResponse()
  }
  return value as unknown as GatewayMessage
}

function parseMessagesResponse(value: unknown): GatewayMessagesResponse {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    return invalidGatewayResponse()
  }
  return { messages: value.messages.map(parseMessage) }
}

function parseNotification(value: unknown): GatewayNotification {
  if (
    !isRecord(value)
    || typeof value.id !== 'number'
    || !Number.isSafeInteger(value.id)
    || typeof value.deviceId !== 'string'
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || typeof value.receivedAt !== 'number'
    || !Number.isSafeInteger(value.receivedAt)
    || !(value.eventType === null || value.eventType === 'POSTED' || value.eventType === 'REMOVED')
    || !(value.sourcePackage === null || typeof value.sourcePackage === 'string')
    || !isNullableInteger(value.notificationId)
    || !isNullableInteger(value.postedAt)
    || !isNullableInteger(value.observedAt)
    || !(value.channelId === null || typeof value.channelId === 'string')
    || !(value.category === null || typeof value.category === 'string')
    || !(value.title === null || typeof value.title === 'string')
    || !(value.body === null || typeof value.body === 'string')
  ) {
    return invalidGatewayResponse()
  }
  return value as unknown as GatewayNotification
}

function parseNotificationsResponse(value: unknown): GatewayNotificationsResponse {
  if (!isRecord(value) || !Array.isArray(value.notifications)) {
    return invalidGatewayResponse()
  }
  return { notifications: value.notifications.map(parseNotification) }
}

function parseOutboundMessage(value: unknown): GatewayOutboundMessage {
  if (
    !isRecord(value)
    || typeof value.id !== 'number'
    || !Number.isSafeInteger(value.id)
    || typeof value.commandId !== 'string'
    || typeof value.deviceId !== 'string'
    || typeof value.slotIndex !== 'number'
    || !Number.isSafeInteger(value.slotIndex)
    || ![0, 1].includes(value.slotIndex)
    || typeof value.recipient !== 'string'
    || typeof value.body !== 'string'
    || ![
      'QUEUED',
      'CLAIMED',
      'CREATED',
      'DISPATCHING',
      'SENT_TO_MODEM',
      'DELIVERED',
      'FAILED',
      'EXPIRED',
    ].includes(String(value.status))
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || typeof value.expiresAt !== 'number'
    || !Number.isSafeInteger(value.expiresAt)
    || !isNullableInteger(value.claimedAt)
    || typeof value.updatedAt !== 'number'
    || !Number.isSafeInteger(value.updatedAt)
    || !isNullableInteger(value.lastResultCode)
    || !(value.errorDetail === null || typeof value.errorDetail === 'string')
  ) {
    return invalidGatewayResponse()
  }
  return value as unknown as GatewayOutboundMessage
}

function parseOutboundMessagesResponse(
  value: unknown,
): GatewayOutboundMessagesResponse {
  if (!isRecord(value) || !Array.isArray(value.outboundMessages)) {
    return invalidGatewayResponse()
  }
  return {
    outboundMessages: value.outboundMessages.map(parseOutboundMessage),
  }
}

function parseOutboundMessageResponse(
  value: unknown,
): GatewayOutboundMessageResponse {
  if (!isRecord(value) || !isRecord(value.outboundMessage)) {
    return invalidGatewayResponse()
  }
  return {
    outboundMessage: parseOutboundMessage(value.outboundMessage),
  }
}

function parseDevicesResponse(value: unknown): GatewayDevicesResponse {
  if (
    !isRecord(value)
    || !Array.isArray(value.devices)
    || !value.devices.every(device => typeof device === 'string')
  ) {
    return invalidGatewayResponse()
  }
  return { devices: value.devices }
}

function parsePairingResponse(value: unknown): GatewayPairingResponse {
  const pairing = isRecord(value) && isRecord(value.pairing)
    ? value.pairing
    : null
  if (
    !pairing
    || typeof pairing.deviceId !== 'string'
    || typeof pairing.expiresAt !== 'number'
    || !Number.isSafeInteger(pairing.expiresAt)
    || typeof pairing.payload !== 'string'
  ) {
    return invalidGatewayResponse()
  }
  return { pairing } as GatewayPairingResponse
}

function parseOtpClaimResponse(value: unknown): GatewayOtpClaimResponse {
  const otp = isRecord(value) && isRecord(value.otp) ? value.otp : null
  if (
    !otp
    || typeof otp.eventId !== 'number'
    || !Number.isSafeInteger(otp.eventId)
    || typeof otp.deviceId !== 'string'
    || typeof otp.receivedAt !== 'number'
    || !Number.isSafeInteger(otp.receivedAt)
    || !isNullableInteger(otp.subscriptionId)
    || !isNullableInteger(otp.slotIndex)
    || typeof otp.code !== 'string'
    || !/^[0-9]{4,8}$/.test(otp.code)
    || typeof otp.expiresAt !== 'number'
    || !Number.isSafeInteger(otp.expiresAt)
  ) {
    return invalidGatewayResponse()
  }
  return { otp } as GatewayOtpClaimResponse
}

export async function checkGatewayHealth(): Promise<GatewayHealthResponse> {
  return parseStatusResponse(await gatewayFetch('/health'))
}

export async function checkGatewayReady(): Promise<GatewayReadyResponse> {
  return parseStatusResponse(await gatewayFetch('/ready'))
}

export async function getGatewayVersion(): Promise<GatewayVersionResponse> {
  return parseVersionResponse(await gatewayFetch('/version'))
}

export async function getGatewayMessages(options: {
  limit?: number
  slotIndex?: number | null
  afterId?: number | null
  beforeId?: number | null
  deviceId?: string
  groupId?: string
} = {}): Promise<GatewayMessagesResponse> {
  const params = new URLSearchParams()
  if (options.limit) params.set('limit', options.limit.toString())
  if (options.slotIndex !== undefined && options.slotIndex !== null) {
    params.set('slotIndex', options.slotIndex.toString())
  }
  if (options.afterId !== undefined && options.afterId !== null) {
    params.set('afterId', options.afterId.toString())
  }
  if (options.beforeId !== undefined && options.beforeId !== null) {
    params.set('beforeId', options.beforeId.toString())
  }
  if (options.deviceId) params.set('deviceId', options.deviceId)
  if (options.groupId) params.set('groupId', options.groupId)
  const query = params.toString()
  return parseMessagesResponse(
    await gatewayFetch(`/v1/messages${query ? `?${query}` : ''}`),
  )
}

export async function getGatewayNotifications(options: {
  limit?: number
  afterId?: number | null
  beforeId?: number | null
  deviceId?: string
  groupId?: string
} = {}): Promise<GatewayNotificationsResponse> {
  const params = new URLSearchParams()
  if (options.limit) params.set('limit', options.limit.toString())
  if (options.afterId !== undefined && options.afterId !== null) {
    params.set('afterId', options.afterId.toString())
  }
  if (options.beforeId !== undefined && options.beforeId !== null) {
    params.set('beforeId', options.beforeId.toString())
  }
  if (options.deviceId) params.set('deviceId', options.deviceId)
  if (options.groupId) params.set('groupId', options.groupId)
  const query = params.toString()
  return parseNotificationsResponse(
    await gatewayFetch(`/v1/notifications${query ? `?${query}` : ''}`),
  )
}

export async function getGatewayOutboundMessages(options: {
  limit?: number
  beforeId?: number | null
  deviceId?: string
  groupId?: string
} = {}): Promise<GatewayOutboundMessagesResponse> {
  const params = new URLSearchParams()
  if (options.limit) params.set('limit', options.limit.toString())
  if (options.beforeId !== undefined && options.beforeId !== null) {
    params.set('beforeId', options.beforeId.toString())
  }
  if (options.deviceId) params.set('deviceId', options.deviceId)
  if (options.groupId) params.set('groupId', options.groupId)
  const query = params.toString()
  return parseOutboundMessagesResponse(
    await gatewayFetch(`/v1/outbound-messages${query ? `?${query}` : ''}`),
  )
}

export async function createGatewayOutboundMessage(options: {
  deviceId: string
  slotIndex: number
  recipient: string
  body: string
  expiresInSeconds: number
  idempotencyKey: string
}): Promise<GatewayOutboundMessageResponse> {
  return parseOutboundMessageResponse(
    await gatewayFetch('/v1/outbound-messages', {
      method: 'POST',
      body: options,
    }),
  )
}

export async function getGatewayDevices(): Promise<GatewayDevicesResponse> {
  return parseDevicesResponse(await gatewayFetch('/v1/devices'))
}

export async function createGatewayPairing(options: {
  deviceId: string
  expiresInSeconds: number
}): Promise<GatewayPairingResponse> {
  return parsePairingResponse(await gatewayFetch('/v1/pairings', {
    method: 'POST',
    body: options,
  }))
}

export async function claimGatewayOtp(options: {
  deviceId?: string
  slotIndex?: number
  maxAgeSeconds?: number
  eventId?: number
}): Promise<GatewayOtpClaimResponse> {
  const body: Record<string, unknown> = {
    maxAgeSeconds: options.maxAgeSeconds ?? 600,
  }
  if (options.slotIndex !== undefined) body.slotIndex = options.slotIndex
  if (options.deviceId !== undefined) body.deviceId = options.deviceId
  if (options.eventId !== undefined) body.eventId = options.eventId

  return parseOtpClaimResponse(await gatewayFetch('/v1/otp/claim', {
    method: 'POST',
    body,
  }))
}

export function clearGatewayConfigForTests(): void {
  gatewayConfig = null
}

function parseDeviceDetail(value: unknown): GatewayDeviceDetail {
  if (
    !isRecord(value)
    || typeof value.deviceId !== 'string'
    || typeof value.description !== 'string'
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || !(value.lastSeenAt === null || (typeof value.lastSeenAt === 'number' && Number.isSafeInteger(value.lastSeenAt)))
    || !(value.retiredAt === null || (typeof value.retiredAt === 'number' && Number.isSafeInteger(value.retiredAt)))
    || !['ONLINE', 'STALE', 'OFFLINE', 'NEVER', 'RETIRED'].includes(String(value.health))
    || !isRecord(value.status)
    || !isRecord(value.status.permissions)
    || !Array.isArray(value.status.lines)
  ) {
    return invalidGatewayResponse()
  }
  return value as unknown as GatewayDeviceDetail
}

function parseDeviceDetailResponse(value: unknown): GatewayDeviceDetailResponse {
  if (!isRecord(value) || !Array.isArray(value.devices)) {
    return invalidGatewayResponse()
  }
  return { devices: value.devices.map(parseDeviceDetail) }
}

function parseSingleDeviceResponse(value: unknown): GatewayDeviceResponse {
  if (!isRecord(value) || !isRecord(value.device)) {
    return invalidGatewayResponse()
  }
  return { device: parseDeviceDetail(value.device) }
}

export async function getGatewayDeviceDetails(): Promise<GatewayDeviceDetailResponse> {
  return parseDeviceDetailResponse(await gatewayFetch('/v1/devices/detail'))
}

export async function createGatewayDevice(options: {
  deviceId: string
  secretBase64: string
  description?: string
}): Promise<GatewayDeviceResponse> {
  return parseSingleDeviceResponse(await gatewayFetch('/v1/devices', {
    method: 'POST',
    body: options,
  }))
}

export async function updateGatewayDevice(
  deviceId: string,
  options: { description?: string; secretBase64?: string },
): Promise<GatewayDeviceResponse> {
  return parseSingleDeviceResponse(await gatewayFetch(`/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    body: options,
  }))
}

export async function deleteGatewayDevice(deviceId: string): Promise<void> {
  await gatewayFetch(`/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  })
}

export async function restoreGatewayDevice(
  deviceId: string,
): Promise<GatewayDeviceResponse> {
  return parseSingleDeviceResponse(
    await gatewayFetch(
      `/v1/devices/${encodeURIComponent(deviceId)}/restore`,
      { method: 'POST', body: {} },
    ),
  )
}

export async function purgeGatewayDevice(deviceId: string): Promise<void> {
  await gatewayFetch(`/v1/devices/${encodeURIComponent(deviceId)}/purge`, {
    method: 'POST',
    body: { confirmation: `PURGE ${deviceId}` },
  })
}

export async function getGatewayAuditLog(): Promise<{
  entries: GatewayAuditEntry[]
}> {
  const value = await gatewayFetch('/v1/audit-log?limit=100')
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return invalidGatewayResponse()
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry)
      || !Number.isSafeInteger(entry.id)
      || !Number.isSafeInteger(entry.occurredAt)
      || typeof entry.clientId !== 'string'
      || typeof entry.action !== 'string'
      || !(entry.deviceId === null || typeof entry.deviceId === 'string')
      || typeof entry.outcome !== 'string'
      || !isRecord(entry.metadata)
    ) return invalidGatewayResponse()
    return entry as unknown as GatewayAuditEntry
  })
  return { entries }
}

function parseDeviceGroup(value: unknown): GatewayDeviceGroup {
  if (
    !isRecord(value)
    || typeof value.groupId !== 'string'
    || !/^[A-Za-z0-9._-]{1,64}$/.test(value.groupId)
    || typeof value.name !== 'string'
    || value.name.length < 1
    || value.name.length > 128
    || !Array.isArray(value.deviceIds)
    || !value.deviceIds.every(deviceId =>
      typeof deviceId === 'string'
      && /^[A-Za-z0-9._-]{1,64}$/.test(deviceId))
    || new Set(value.deviceIds).size !== value.deviceIds.length
    || !Number.isSafeInteger(value.createdAt)
    || (value.createdAt as number) < 0
    || !Number.isSafeInteger(value.updatedAt)
    || (value.updatedAt as number) < 0
  ) return invalidGatewayResponse()
  return value as unknown as GatewayDeviceGroup
}

export async function getGatewayDeviceGroups(): Promise<{
  groups: GatewayDeviceGroup[]
}> {
  const value = await gatewayFetch('/v1/device-groups')
  if (!isRecord(value) || !Array.isArray(value.groups)) {
    return invalidGatewayResponse()
  }
  return { groups: value.groups.map(parseDeviceGroup) }
}

export async function createGatewayDeviceGroup(options: {
  groupId: string
  name: string
  deviceIds: string[]
}): Promise<{ group: GatewayDeviceGroup }> {
  const value = await gatewayFetch('/v1/device-groups', {
    method: 'POST',
    body: options,
  })
  if (!isRecord(value) || !isRecord(value.group)) {
    return invalidGatewayResponse()
  }
  return { group: parseDeviceGroup(value.group) }
}

export async function updateGatewayDeviceGroup(
  groupId: string,
  options: { name?: string; deviceIds?: string[] },
): Promise<{ group: GatewayDeviceGroup }> {
  const value = await gatewayFetch(
    `/v1/device-groups/${encodeURIComponent(groupId)}`,
    { method: 'PUT', body: options },
  )
  if (!isRecord(value) || !isRecord(value.group)) {
    return invalidGatewayResponse()
  }
  return { group: parseDeviceGroup(value.group) }
}

export async function deleteGatewayDeviceGroup(groupId: string): Promise<void> {
  await gatewayFetch(`/v1/device-groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
  })
}

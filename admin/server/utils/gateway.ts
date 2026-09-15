import { readFileSync } from 'node:fs'
import type { H3Event } from 'h3'
import { createError, setResponseHeader } from 'h3'

let gatewayConfig: {
  token: string
  baseUrl: string
} | null = null

const FORWARDED_STATUS_CODES = new Set([400, 401, 403, 404, 410, 429, 503])

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
    case 410: return 'Gateway resource is no longer available'
    case 429: return 'Gateway rate limit exceeded'
    case 503: return 'Gateway service is not ready'
    default: return 'Gateway service unavailable'
  }
}

export async function gatewayFetch(
  path: string,
  options: {
    method?: 'GET' | 'POST'
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
  if (body && method === 'POST') {
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

export interface GatewayPairingResponse {
  pairing: {
    deviceId: string
    expiresAt: number
    payload: string
  }
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
} = {}): Promise<GatewayMessagesResponse> {
  const params = new URLSearchParams()
  if (options.limit) params.set('limit', options.limit.toString())
  if (options.slotIndex !== undefined && options.slotIndex !== null) {
    params.set('slotIndex', options.slotIndex.toString())
  }
  if (options.afterId !== undefined && options.afterId !== null) {
    params.set('afterId', options.afterId.toString())
  }
  const query = params.toString()
  return parseMessagesResponse(
    await gatewayFetch(`/v1/messages${query ? `?${query}` : ''}`),
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
  slotIndex?: number
  maxAgeSeconds?: number
  eventId?: number
}): Promise<GatewayOtpClaimResponse> {
  const body: Record<string, unknown> = {
    maxAgeSeconds: options.maxAgeSeconds ?? 600,
  }
  if (options.slotIndex !== undefined) body.slotIndex = options.slotIndex
  if (options.eventId !== undefined) body.eventId = options.eventId

  return parseOtpClaimResponse(await gatewayFetch('/v1/otp/claim', {
    method: 'POST',
    body,
  }))
}

export function clearGatewayConfigForTests(): void {
  gatewayConfig = null
}

import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  claimGatewayOtp,
} from '../../../utils/gateway'

export default defineEventHandler(async (event) => {
  // Require authentication
  const session = requireAuth(event)
  requireCsrf(event, session)

  // Parse request body
  const body = await readBody(event)

  if (!body || typeof body !== 'object') {
    throw createError({
      statusCode: 400,
      message: 'Invalid request body',
    })
  }

  const { deviceId, slotIndex, maxAgeSeconds, eventId } = body
  if (
    deviceId !== undefined
    && (typeof deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId))
  ) {
    throw createError({ statusCode: 400, message: 'Invalid deviceId' })
  }

  // Validate parameters
  if (
    slotIndex !== undefined
    && (
      typeof slotIndex !== 'number'
      || !Number.isInteger(slotIndex)
      || ![0, 1].includes(slotIndex)
    )
  ) {
    throw createError({
      statusCode: 400,
      message: 'Invalid slotIndex',
    })
  }

  if (maxAgeSeconds !== undefined) {
    if (
      typeof maxAgeSeconds !== 'number'
      || !Number.isInteger(maxAgeSeconds)
      || maxAgeSeconds < 30
      || maxAgeSeconds > 3600
    ) {
      throw createError({
        statusCode: 400,
        message: 'Invalid maxAgeSeconds',
      })
    }
  }

  if (
    eventId !== undefined
    && (
      typeof eventId !== 'number'
      || !Number.isInteger(eventId)
      || eventId < 1
    )
  ) {
    throw createError({
      statusCode: 400,
      message: 'Invalid eventId',
    })
  }

  try {
    // Claim OTP from Gateway
    const result = await claimGatewayOtp({
      ...(slotIndex !== undefined ? { slotIndex } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      maxAgeSeconds: maxAgeSeconds ?? 600,
      eventId,
    })

    setResponseHeaders(event, {
      'Cache-Control': 'no-store',
    })

    return result
  } catch (error: unknown) {
    applyGatewayErrorHeaders(event, error)
    // Handle specific Gateway errors
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const statusCode = (error as { statusCode: number }).statusCode
      if (statusCode === 404) {
        throw createError({
          statusCode: 404,
          message: 'OTP was already claimed or is no longer available',
        })
      }
    }
    throw error
  }
})

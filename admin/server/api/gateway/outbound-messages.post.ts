import {
  applyGatewayErrorHeaders,
  createGatewayOutboundMessage,
} from '../../utils/gateway'
import { requireAuth, requireCsrf } from '../../utils/session'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const body = await readBody(event)
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).some(key => ![
      'deviceId',
      'slotIndex',
      'recipient',
      'body',
      'expiresInSeconds',
      'idempotencyKey',
    ].includes(key))
    || typeof body.deviceId !== 'string'
    || !/^[A-Za-z0-9._-]{1,64}$/.test(body.deviceId)
    || !Number.isSafeInteger(body.slotIndex)
    || ![0, 1].includes(body.slotIndex)
    || typeof body.recipient !== 'string'
    || body.recipient.trim().length < 1
    || body.recipient.trim().length > 64
    || /[A-Za-z]/.test(body.recipient)
    || typeof body.body !== 'string'
    || body.body.length < 1
    || body.body.length > 2_000
    || !Number.isSafeInteger(body.expiresInSeconds)
    || body.expiresInSeconds < 60
    || body.expiresInSeconds > 3_600
    || typeof body.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9._-]{16,128}$/.test(body.idempotencyKey)
  ) {
    throw createError({
      statusCode: 400,
      message: 'Invalid outbound message request',
    })
  }
  try {
    const result = await createGatewayOutboundMessage({
      deviceId: body.deviceId,
      slotIndex: body.slotIndex,
      recipient: body.recipient.trim(),
      body: body.body,
      expiresInSeconds: body.expiresInSeconds,
      idempotencyKey: body.idempotencyKey,
    })
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

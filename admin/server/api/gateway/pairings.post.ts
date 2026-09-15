import { requireAuth, requireCsrf } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  createGatewayPairing,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const body = await readBody(event)
  const deviceId = body?.deviceId
  const expiresInSeconds = body?.expiresInSeconds ?? 300
  if (
    typeof deviceId !== 'string'
    || !/^[A-Za-z0-9._-]{3,64}$/.test(deviceId)
    || typeof expiresInSeconds !== 'number'
    || !Number.isInteger(expiresInSeconds)
    || expiresInSeconds < 60
    || expiresInSeconds > 600
  ) {
    throw createError({ statusCode: 400, message: 'Invalid pairing request' })
  }
  try {
    const result = await createGatewayPairing({ deviceId, expiresInSeconds })
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

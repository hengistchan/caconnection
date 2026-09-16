import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  updateGatewayDevice,
} from '../../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const deviceId = getRouterParam(event, 'deviceId')
  if (!deviceId) {
    throw createError({
      statusCode: 400,
      message: 'deviceId is required',
    })
  }
  const body = await readBody(event)
  if (!body || typeof body !== 'object') {
    throw createError({
      statusCode: 400,
      message: 'Invalid request body',
    })
  }
  const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description')
  const hasSecret = Object.prototype.hasOwnProperty.call(body, 'secretBase64')
  if (
    (!hasDescription && !hasSecret)
    || (hasDescription && typeof body.description !== 'string')
    || (hasSecret && typeof body.secretBase64 !== 'string')
  ) {
    throw createError({
      statusCode: 400,
      message: 'description or secretBase64 is required',
    })
  }
  try {
    const result = await updateGatewayDevice(deviceId, {
      description: body.description,
      secretBase64: body.secretBase64,
    })
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

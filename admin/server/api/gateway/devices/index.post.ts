import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  createGatewayDevice,
} from '../../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const body = await readBody(event)
  if (
    !body
    || typeof body !== 'object'
    || typeof body.deviceId !== 'string'
    || typeof body?.secretBase64 !== 'string'
    || !(body.description === undefined || typeof body.description === 'string')
  ) {
    throw createError({
      statusCode: 400,
      message: 'deviceId and secretBase64 are required',
    })
  }
  try {
    const result = await createGatewayDevice({
      deviceId: body.deviceId,
      secretBase64: body.secretBase64,
      description: body.description ?? '',
    })
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

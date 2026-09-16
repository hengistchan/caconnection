import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  deleteGatewayDevice,
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
  try {
    await deleteGatewayDevice(deviceId)
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return { deleted: true }
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

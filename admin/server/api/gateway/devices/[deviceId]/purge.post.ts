import { requireAuth, requireCsrf } from '../../../../utils/session'
import {
  applyGatewayErrorHeaders,
  purgeGatewayDevice,
} from '../../../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const deviceId = getRouterParam(event, 'deviceId')
  const body = await readBody(event)
  if (
    !deviceId
    || !body
    || typeof body !== 'object'
    || body.confirmation !== `PURGE ${deviceId}`
  ) {
    throw createError({ statusCode: 400, message: 'Exact purge confirmation is required' })
  }
  try {
    await purgeGatewayDevice(deviceId)
    return { purged: true }
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

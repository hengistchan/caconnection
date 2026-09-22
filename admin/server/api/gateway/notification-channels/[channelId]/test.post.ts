import { requireAuth, requireCsrf } from '../../../../utils/session'
import {
  applyGatewayErrorHeaders,
  testGatewayNotificationChannel,
} from '../../../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const channelId = getRouterParam(event, 'channelId')
  const body = await readBody(event)
  if (
    !channelId
    || !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).length !== 0
  ) {
    throw createError({ statusCode: 400, message: 'Empty request required' })
  }
  try {
    return await testGatewayNotificationChannel(channelId)
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

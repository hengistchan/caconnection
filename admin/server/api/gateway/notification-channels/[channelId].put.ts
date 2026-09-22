import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  updateGatewayNotificationChannel,
} from '../../../utils/gateway'

const allowedEvents = new Set([
  'sms.received',
  'call.ringing',
  'call.missed',
  'call.ended',
  'notification.received',
])

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
    || Object.keys(body).some(key => !['enabled', 'contentMode', 'eventTypes'].includes(key))
    || typeof body.enabled !== 'boolean'
    || !['REDACTED', 'FULL'].includes(String(body.contentMode))
    || !Array.isArray(body.eventTypes)
    || body.eventTypes.length === 0
    || body.eventTypes.some((value: unknown) => typeof value !== 'string' || !allowedEvents.has(value))
  ) {
    throw createError({ statusCode: 400, message: 'Invalid notification channel settings' })
  }
  try {
    return await updateGatewayNotificationChannel(channelId, {
      enabled: body.enabled,
      contentMode: body.contentMode,
      eventTypes: body.eventTypes,
    })
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

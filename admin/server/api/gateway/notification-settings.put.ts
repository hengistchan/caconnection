import { requireAuth, requireCsrf } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  updateGatewayNotificationSettings,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const body = await readBody(event)
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).some(key => !['enabled', 'contentMode'].includes(key))
    || typeof body.enabled !== 'boolean'
    || !['REDACTED', 'FULL'].includes(String(body.contentMode))
  ) {
    throw createError({ statusCode: 400, message: 'Invalid notification settings' })
  }
  try {
    return await updateGatewayNotificationSettings({
      enabled: body.enabled,
      contentMode: body.contentMode,
    })
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

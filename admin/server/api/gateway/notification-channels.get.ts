import { requireAuth } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  getGatewayNotificationChannels,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  try {
    const result = await getGatewayNotificationChannels()
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

import { requireAuth } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  getGatewayDevices,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  try {
    const result = await getGatewayDevices()
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

import { requireAuth } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  getGatewayDeviceGroups,
} from '../../../utils/gateway'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  try {
    return await getGatewayDeviceGroups()
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

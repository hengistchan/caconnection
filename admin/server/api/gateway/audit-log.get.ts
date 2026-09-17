import { requireAuth } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  getGatewayAuditLog,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  try {
    return await getGatewayAuditLog()
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  deleteGatewayDeviceGroup,
} from '../../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const groupId = getRouterParam(event, 'groupId')
  if (!groupId || !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)) {
    throw createError({ statusCode: 400, message: 'Invalid groupId' })
  }
  try {
    await deleteGatewayDeviceGroup(groupId)
    return { deleted: true }
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

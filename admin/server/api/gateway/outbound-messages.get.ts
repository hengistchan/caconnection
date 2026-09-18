import {
  applyGatewayErrorHeaders,
  getGatewayOutboundMessages,
} from '../../utils/gateway'
import { requireAuth } from '../../utils/session'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const query = getQuery(event)
  const allowed = new Set(['limit', 'beforeId', 'deviceId', 'groupId'])
  if (
    Object.entries(query).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value),
    )
  ) {
    throw createError({ statusCode: 400, message: 'Invalid query' })
  }
  const limit = query.limit === undefined ? 50 : Number(query.limit)
  const beforeId = query.beforeId === undefined ? null : Number(query.beforeId)
  const deviceId = query.deviceId === undefined ? undefined : String(query.deviceId)
  const groupId = query.groupId === undefined ? undefined : String(query.groupId)
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 100
    || (
      beforeId !== null
      && (!Number.isSafeInteger(beforeId) || beforeId < 1)
    )
    || (
      deviceId !== undefined
      && !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)
    )
    || (
      groupId !== undefined
      && (
        !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)
        || deviceId !== undefined
      )
    )
  ) {
    throw createError({ statusCode: 400, message: 'Invalid query' })
  }
  try {
    const result = await getGatewayOutboundMessages({
      limit,
      beforeId,
      deviceId,
      groupId,
    })
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

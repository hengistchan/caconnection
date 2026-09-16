import {
  applyGatewayErrorHeaders,
  getGatewayOutboundMessages,
} from '../../utils/gateway'
import { requireAuth } from '../../utils/session'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const query = getQuery(event)
  const allowed = new Set(['limit', 'beforeId', 'deviceId'])
  if (Object.keys(query).some(key => !allowed.has(key))) {
    throw createError({ statusCode: 400, message: 'Invalid query' })
  }
  const limit = query.limit === undefined ? 50 : Number(query.limit)
  const beforeId = query.beforeId === undefined ? null : Number(query.beforeId)
  const deviceId = query.deviceId === undefined ? undefined : String(query.deviceId)
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
  ) {
    throw createError({ statusCode: 400, message: 'Invalid query' })
  }
  try {
    const result = await getGatewayOutboundMessages({
      limit,
      beforeId,
      deviceId,
    })
    setResponseHeaders(event, { 'Cache-Control': 'no-store' })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

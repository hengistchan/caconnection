import { requireAuth } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  getGatewayCalls,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  requireAuth(event)
  const query = getQuery(event)
  const allowed = new Set([
    'limit',
    'slotIndex',
    'afterId',
    'beforeId',
    'deviceId',
    'groupId',
  ])
  if (
    Object.entries(query).some(
      ([key, value]) => !allowed.has(key) || Array.isArray(value),
    )
  ) {
    throw createError({ statusCode: 400, message: 'Invalid query' })
  }

  const limit = query.limit ? parseInt(String(query.limit), 10) : 50
  const slotIndex = query.slotIndex === undefined || query.slotIndex === ''
    ? null
    : parseInt(String(query.slotIndex), 10)
  const afterId = query.afterId ? parseInt(String(query.afterId), 10) : null
  const beforeId = query.beforeId ? parseInt(String(query.beforeId), 10) : null
  const deviceId = query.deviceId === undefined ? undefined : String(query.deviceId)
  const groupId = query.groupId === undefined ? undefined : String(query.groupId)

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw createError({ statusCode: 400, message: 'Invalid limit parameter' })
  }
  if (slotIndex !== null && ![0, 1].includes(slotIndex)) {
    throw createError({ statusCode: 400, message: 'Invalid slotIndex parameter' })
  }
  if (afterId !== null && (!Number.isInteger(afterId) || afterId < 0)) {
    throw createError({ statusCode: 400, message: 'Invalid afterId parameter' })
  }
  if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId < 1)) {
    throw createError({ statusCode: 400, message: 'Invalid beforeId parameter' })
  }
  if (afterId !== null && beforeId !== null) {
    throw createError({
      statusCode: 400,
      message: 'afterId and beforeId cannot be combined',
    })
  }
  if (deviceId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
    throw createError({ statusCode: 400, message: 'Invalid deviceId parameter' })
  }
  if (
    groupId !== undefined
    && (
      !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)
      || deviceId !== undefined
    )
  ) {
    throw createError({ statusCode: 400, message: 'Invalid groupId parameter' })
  }

  try {
    const result = await getGatewayCalls({
      limit,
      slotIndex,
      afterId,
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

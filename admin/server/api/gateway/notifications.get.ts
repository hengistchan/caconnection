import { requireAuth } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  getGatewayNotifications,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  requireAuth(event)

  const query = getQuery(event)
  const limit = query.limit ? parseInt(query.limit as string, 10) : 50
  const afterId = query.afterId ? parseInt(query.afterId as string, 10) : null
  const beforeId = query.beforeId ? parseInt(query.beforeId as string, 10) : null

  if (isNaN(limit) || limit < 1 || limit > 100) {
    throw createError({
      statusCode: 400,
      message: 'Invalid limit parameter',
    })
  }

  if (afterId !== null && (isNaN(afterId) || afterId < 0)) {
    throw createError({
      statusCode: 400,
      message: 'Invalid afterId parameter',
    })
  }
  if (beforeId !== null && (isNaN(beforeId) || beforeId < 1)) {
    throw createError({
      statusCode: 400,
      message: 'Invalid beforeId parameter',
    })
  }
  if (afterId !== null && beforeId !== null) {
    throw createError({
      statusCode: 400,
      message: 'afterId and beforeId cannot be combined',
    })
  }

  try {
    const result = await getGatewayNotifications({ limit, afterId, beforeId })
    setResponseHeaders(event, {
      'Cache-Control': 'no-store',
    })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

import { requireAuth } from '../../utils/session'
import {
  applyGatewayErrorHeaders,
  getGatewayMessages,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  // Require authentication
  requireAuth(event)

  // Parse query parameters
  const query = getQuery(event)

  const limit = query.limit ? parseInt(query.limit as string, 10) : 50
  const slotIndex = query.slotIndex !== undefined && query.slotIndex !== ''
    ? parseInt(query.slotIndex as string, 10)
    : null
  const afterId = query.afterId ? parseInt(query.afterId as string, 10) : null

  // Validate parameters
  if (isNaN(limit) || limit < 1 || limit > 100) {
    throw createError({
      statusCode: 400,
      message: 'Invalid limit parameter',
    })
  }

  if (slotIndex !== null && (isNaN(slotIndex) || ![0, 1].includes(slotIndex))) {
    throw createError({
      statusCode: 400,
      message: 'Invalid slotIndex parameter',
    })
  }

  if (afterId !== null && (isNaN(afterId) || afterId < 0)) {
    throw createError({
      statusCode: 400,
      message: 'Invalid afterId parameter',
    })
  }

  // Fetch messages from Gateway
  try {
    const result = await getGatewayMessages({
      limit,
      slotIndex,
      afterId,
    })
    setResponseHeaders(event, {
      'Cache-Control': 'no-store',
    })
    return result
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

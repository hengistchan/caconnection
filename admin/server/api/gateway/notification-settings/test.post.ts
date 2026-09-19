import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  testGatewayNotification,
} from '../../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw createError({ statusCode: 400, message: 'Empty request required' })
  }
  try {
    return await testGatewayNotification()
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

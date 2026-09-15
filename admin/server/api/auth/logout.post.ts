import {
  clearSessionCookie,
  requireAuth,
  requireCsrf,
} from '../../utils/session'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  clearSessionCookie(event)

  // Return success
  setResponseHeaders(event, {
    'Cache-Control': 'no-store',
  })

  return {
    success: true,
    message: 'Logged out successfully',
  }
})

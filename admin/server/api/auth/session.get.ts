import { getSessionFromCookies } from '../../utils/session'

export default defineEventHandler(async (event) => {
  const session = getSessionFromCookies(event)

  setResponseHeaders(event, {
    'Cache-Control': 'no-store',
  })

  return {
    authenticated: session !== null,
    csrfToken: session?.csrfToken ?? null,
  }
})

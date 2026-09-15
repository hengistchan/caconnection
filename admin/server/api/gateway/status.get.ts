import { requireAuth } from '../../utils/session'
import {
  checkGatewayHealth,
  checkGatewayReady,
  getGatewayVersion,
} from '../../utils/gateway'

export default defineEventHandler(async (event) => {
  // Require authentication
  requireAuth(event)

  // Fetch all status information in parallel
  const [healthResult, readyResult, versionResult] = await Promise.allSettled([
    checkGatewayHealth(),
    checkGatewayReady(),
    getGatewayVersion(),
  ])

  setResponseHeaders(event, {
    'Cache-Control': 'no-store',
  })

  return {
    health: healthResult.status === 'fulfilled'
      ? { status: healthResult.value.status, ok: true }
      : { status: 'error', ok: false },
    ready: readyResult.status === 'fulfilled'
      ? { status: readyResult.value.status, ok: readyResult.value.status === 'ready' }
      : { status: 'error', ok: false },
    version: versionResult.status === 'fulfilled'
      ? versionResult.value
      : null,
    timestamp: Date.now(),
  }
})

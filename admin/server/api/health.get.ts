export default defineEventHandler(async (event) => {
  setResponseHeaders(event, {
    'Cache-Control': 'no-store',
  })

  return {
    status: 'ok',
    service: 'caconnection-admin',
    timestamp: Date.now(),
  }
})

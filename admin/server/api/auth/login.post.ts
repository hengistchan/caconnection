import { createError, readBody, setResponseStatus } from 'h3'
import { verifyPassword } from '../../utils/crypto'
import {
  createSession,
  requireSameOrigin,
  setSessionCookie,
} from '../../utils/session'
import { loadAdminConfig } from '../../utils/config'
import {
  checkLoginRateLimit,
  recordLoginAttempt,
  clearLoginAttempts,
  getClientIp,
} from '../../utils/rate-limiter'

export default defineEventHandler(async (event) => {
  requireSameOrigin(event)

  // Check rate limit
  const clientIp = getClientIp(event)
  const rateLimit = checkLoginRateLimit(clientIp)

  if (!rateLimit.allowed) {
    const retryAfterSeconds = Math.ceil(rateLimit.retryAfterMs / 1000)
    setResponseStatus(event, 429)
    setResponseHeaders(event, {
      'Retry-After': retryAfterSeconds.toString(),
      'Cache-Control': 'no-store',
    })
    throw createError({
      statusCode: 429,
      message: 'Too many login attempts. Please try again later.',
    })
  }

  // Parse request body
  const body = await readBody(event)

  if (!body || typeof body !== 'object') {
    throw createError({
      statusCode: 400,
      message: 'Invalid request body',
    })
  }

  const { password } = body

  // Validate password input
  if (typeof password !== 'string' || password.length === 0) {
    throw createError({
      statusCode: 400,
      message: 'Password is required',
    })
  }

  // Prevent extremely long passwords (DoS protection)
  if (password.length > 1024) {
    throw createError({
      statusCode: 400,
      message: 'Invalid password',
    })
  }

  // Load admin config and verify password
  const { passwordHash } = loadAdminConfig()

  let isValid = false
  try {
    isValid = await verifyPassword(password, passwordHash)
  } catch {
    // Hash verification failed - treat as invalid password
    isValid = false
  }

  if (!isValid) {
    // Record failed attempt
    recordLoginAttempt(clientIp)

    // Use generic error message (don't reveal if user exists)
    throw createError({
      statusCode: 401,
      message: 'Invalid credentials',
    })
  }

  // Successful login - clear rate limit attempts
  clearLoginAttempts(clientIp)

  // Create session
  const session = createSession()
  setSessionCookie(event, session)

  // Return success (no sensitive data)
  setResponseHeaders(event, {
    'Cache-Control': 'no-store',
  })

  return {
    success: true,
    message: 'Login successful',
    csrfToken: session.csrfToken,
  }
})

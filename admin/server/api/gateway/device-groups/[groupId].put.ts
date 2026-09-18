import { requireAuth, requireCsrf } from '../../../utils/session'
import {
  applyGatewayErrorHeaders,
  updateGatewayDeviceGroup,
} from '../../../utils/gateway'

export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  requireCsrf(event, session)
  const groupId = getRouterParam(event, 'groupId')
  const body = await readBody(event)
  if (
    !groupId
    || !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)
    || !body
    || typeof body !== 'object'
    || (
      body.name === undefined
      && body.deviceIds === undefined
    )
    || (
      body.name !== undefined
      && (
        typeof body.name !== 'string'
        || body.name.trim().length < 1
        || body.name.trim().length > 128
      )
    )
    || (
      body.deviceIds !== undefined
      && (
        !Array.isArray(body.deviceIds)
        || !body.deviceIds.every(
          (deviceId: unknown) =>
            typeof deviceId === 'string'
            && /^[A-Za-z0-9._-]{1,64}$/.test(deviceId),
          )
        || new Set(body.deviceIds).size !== body.deviceIds.length
      )
    )
  ) {
    throw createError({ statusCode: 400, message: 'Invalid device group' })
  }
  try {
    return await updateGatewayDeviceGroup(groupId, {
      name: body.name,
      deviceIds: body.deviceIds,
    })
  } catch (error) {
    applyGatewayErrorHeaders(event, error)
    throw error
  }
})

// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  generateDeviceSecret,
  validateDeviceSecret,
} from '../app/utils/deviceSecret'

describe('device secret helpers', () => {
  it('accepts a 32-byte Base64 secret', () => {
    const secret = btoa('x'.repeat(32))
    expect(validateDeviceSecret(secret)).toEqual({
      valid: true,
      decodedBytes: 32,
      reason: null,
    })
  })

  it('rejects malformed and short secrets', () => {
    expect(validateDeviceSecret('not base64')).toMatchObject({
      valid: false,
      reason: 'format',
    })
    expect(validateDeviceSecret(btoa('short'))).toMatchObject({
      valid: false,
      reason: 'length',
    })
  })

  it('generates a valid secret', () => {
    expect(validateDeviceSecret(generateDeviceSecret()).valid).toBe(true)
  })
})

export interface SecretValidation {
  valid: boolean
  decodedBytes: number
  reason: 'empty' | 'format' | 'length' | null
}

export function validateDeviceSecret(value: string): SecretValidation {
  const normalized = value.trim()
  if (!normalized) {
    return { valid: false, decodedBytes: 0, reason: 'empty' }
  }
  if (
    normalized.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  ) {
    return { valid: false, decodedBytes: 0, reason: 'format' }
  }
  try {
    const decodedBytes = atob(normalized).length
    return decodedBytes >= 32
      ? { valid: true, decodedBytes, reason: null }
      : { valid: false, decodedBytes, reason: 'length' }
  } catch {
    return { valid: false, decodedBytes: 0, reason: 'format' }
  }
}

export function generateDeviceSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Encoding utilities that must produce byte-identical output to the Python
 * gateway. Uses standard Base64 (not Base64URL) throughout.
 */

/**
 * Decode a standard Base64 string, throwing on invalid input.
 */
export function base64Decode(input: string): Buffer {
  if (
    input.length === 0
    || input.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)
  ) {
    throw new Error('invalid base64');
  }
  const decoded = Buffer.from(input, 'base64');
  if (decoded.toString('base64') !== input) {
    throw new Error('invalid base64');
  }
  return decoded;
}

/**
 * Encode bytes to standard Base64 string.
 */
export function base64Encode(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

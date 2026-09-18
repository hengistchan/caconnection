/**
 * Encoding utilities that must produce byte-identical output to the Python
 * gateway. Uses standard Base64 (not Base64URL) throughout.
 */

/**
 * Decode a standard Base64 string, throwing on invalid input.
 */
export function base64Decode(input: string): Buffer {
  return Buffer.from(input, 'base64');
}

/**
 * Encode bytes to standard Base64 string.
 */
export function base64Encode(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

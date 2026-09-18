/**
 * OTP candidate extraction from SMS body text.
 *
 * Must match the Python gateway exactly:
 *   - Pattern: (?<!\d)(\d{4,8})(?!\d)
 *   - Context pattern: verification keywords in local sentence
 *   - Context boundaries: 。！?？;；\n
 *   - Ranking: contextual matches first, then preferred length (6,4), then position
 */

// Boundary characters for OTP context extraction
const OTP_CONTEXT_BOUNDARIES = '.。!！?？;；\n';

// Regex matching 4-8 digit sequences not adjacent to other digits
const OTP_PATTERN = /(?<!\d)(\d{4,8})(?!\d)/g;

// Keywords indicating OTP context
const OTP_CONTEXT_PATTERN = /验证码|校验码|动态码|认证码|口令|otp|verification|verify|code|passcode/i;

/**
 * Extract the local context around an OTP match.
 * Finds the nearest boundary characters on each side.
 */
function otpLocalContext(body: string, start: number, end: number): string {
  let left = -1;
  for (const boundary of OTP_CONTEXT_BOUNDARIES) {
    const pos = body.lastIndexOf(boundary, start);
    if (pos > left) left = pos;
  }

  let right = body.length;
  for (const boundary of OTP_CONTEXT_BOUNDARIES) {
    const pos = body.indexOf(boundary, end);
    if (pos >= 0 && pos < right) right = pos;
  }

  return body.slice(left + 1, right);
}

/**
 * Extract likely OTP candidates from SMS body.
 * Returns values ranked by likelihood (same order as Python).
 */
export function extractOtpCandidates(body: string | null | undefined): string[] {
  if (!body) return [];

  const ranked: Array<[boolean, boolean, number, string]> = [];
  const seen = new Set<string>();

  // Reset regex state
  OTP_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = OTP_PATTERN.exec(body)) !== null) {
    const value = match[1]!;
    if (seen.has(value)) continue;
    seen.add(value);

    const context = otpLocalContext(body, match.index, match.index + value.length);
    const contextual = OTP_CONTEXT_PATTERN.test(context);
    const preferredLength = value.length === 6 || value.length === 4;

    // Python ranking: (not contextual, not preferred_length, position, value)
    // sorted ascending — so contextual matches come first (False < True),
    // preferred lengths come first
    ranked.push([!contextual, !preferredLength, match.index, value]);
  }

  // Sort: first by not-contextual (false first), then by not-preferred-length (false first), then by position
  ranked.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] ? 1 : -1;
    if (a[1] !== b[1]) return a[1] ? 1 : -1;
    return a[2] - b[2];
  });

  return ranked.map(([, , , value]) => value);
}

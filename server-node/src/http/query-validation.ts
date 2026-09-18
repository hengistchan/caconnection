export class InvalidQueryError extends Error {
  constructor() {
    super('invalid query');
  }
}

export function assertAllowedQuery(
  query: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): void {
  if (Object.keys(query).some(key => !allowedKeys.has(key))) {
    throw new InvalidQueryError();
  }
  if (Object.values(query).some(value => Array.isArray(value))) {
    throw new InvalidQueryError();
  }
}

export function parseLimit(value: unknown, fallback = 50, maximum = 100): number {
  if (value === undefined) return fallback;
  return parseInteger(value, 1, maximum);
}

export function parseAfterId(value: unknown): number | undefined {
  return value === undefined ? undefined : parseInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

export function parseBeforeId(value: unknown): number | undefined {
  return value === undefined ? undefined : parseInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

export function parseSlotIndex(value: unknown): number | undefined {
  return value === undefined ? undefined : parseInteger(value, 0, 1);
}

export function parseIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new InvalidQueryError();
  }
  return value;
}

function parseInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new InvalidQueryError();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new InvalidQueryError();
  }
  return parsed;
}

/**
 * Recursively strip server-only crypto material (encKey, encNonce) from any
 * Track-shaped objects in a response. Use this on ANY endpoint that returns
 * tracks via Prisma `include`.
 */
export function stripCryptoFields<T>(value: T): T {
  if (value === null || value === undefined) return value;

  // Prisma Date instances are objects with no enumerable keys — without this
  // guard they become `{}` in JSON and break iOS decoding on detail endpoints.
  if (value instanceof Date) return value;

  if (Array.isArray(value)) {
    return value.map(stripCryptoFields) as unknown as T;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (key === 'encKey' || key === 'encNonce') continue;
      out[key] = stripCryptoFields(obj[key]);
    }
    return out as unknown as T;
  }

  return value;
}

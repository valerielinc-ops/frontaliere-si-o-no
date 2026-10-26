export type CacheValueNormalizer<T> = (value: unknown) => T | undefined;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the small localStorage envelopes used by the author override caches.
 * A malformed cache must be treated as a miss so Firestore can rebuild it.
 */
export function parseAuthorCacheMap<T>(
  raw: string | null,
  ttlMs: number,
  normalize: CacheValueNormalizer<T>,
  now = Date.now(),
): Map<string, T> | null {
  if (!raw || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.data)) return null;
    if (
      typeof parsed.timestamp !== 'number' ||
      !Number.isFinite(parsed.timestamp) ||
      parsed.timestamp < 0 ||
      parsed.timestamp > now ||
      (now - parsed.timestamp) >= ttlMs
    ) return null;

    const entries = Object.entries(parsed.data);
    const result = new Map<string, T>();
    for (const [key, value] of entries) {
      const normalized = normalize(value);
      if (normalized !== undefined) result.set(key, normalized);
    }

    // A non-empty envelope whose every value is malformed is a cache miss,
    // rather than a valid empty cache that would suppress Firestore recovery.
    return entries.length > 0 && result.size === 0 ? null : result;
  } catch {
    return null;
  }
}

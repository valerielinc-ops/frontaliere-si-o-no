export type AuthorProfilePatch = Partial<Record<'name' | 'role' | 'bio' | 'photoPath', string>>;

export interface ArticleAuthorOverride {
  authorSlug: string;
  authorName: string;
}

export const AUTHOR_PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;

const EDITORIAL_PROFILE_FIELDS = ['name', 'role', 'bio', 'photoPath'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Strip contact/social/auth fields from admin profile documents. */
export function sanitizeAuthorProfilePatch(value: unknown): AuthorProfilePatch | undefined {
  if (!isPlainObject(value)) return undefined;
  const patch: AuthorProfilePatch = {};
  for (const field of EDITORIAL_PROFILE_FIELDS) {
    if (typeof value[field] === 'string') patch[field] = value[field].trim();
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function sanitizeArticleAuthorOverride(value: unknown): ArticleAuthorOverride | undefined {
  if (!isPlainObject(value)) return undefined;
  const { authorSlug, authorName } = value;
  if (typeof authorSlug !== 'string' || typeof authorName !== 'string' || !authorSlug || !authorName) {
    return undefined;
  }
  return { authorSlug, authorName };
}

type LocalMapValueSanitizer<T> = (value: unknown) => T | undefined;

function parseMapEnvelope<T>(
  envelope: unknown,
  ttlMs: number,
  sanitizeValue: LocalMapValueSanitizer<T>,
  now: number,
): Map<string, T> | null {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !isPlainObject(envelope) || !isPlainObject(envelope.data)) {
    return null;
  }

  const { timestamp } = envelope;
  if (
    typeof timestamp !== 'number'
    || !Number.isFinite(timestamp)
    || timestamp < 0
    || timestamp > now
    || now - timestamp >= ttlMs
  ) return null;

  const map = new Map<string, T>();
  const entries = Object.entries(envelope.data);
  for (const [key, rawValue] of entries) {
    const value = sanitizeValue(rawValue);
    if (value !== undefined) map.set(key, value);
  }

  // A non-empty envelope with no valid entries is a cache miss, so Firestore
  // can rebuild it instead of treating malformed data as an authoritative hit.
  return entries.length > 0 && map.size === 0 ? null : map;
}

export function parseLocalMapEnvelope<T>(
  envelope: unknown,
  sanitizeValue: LocalMapValueSanitizer<T>,
  now = Date.now(),
): Map<string, T> | null {
  return parseMapEnvelope(envelope, AUTHOR_PROFILE_CACHE_TTL_MS, sanitizeValue, now);
}

/** Compatibility parser for the original raw localStorage cache API. */
export type CacheValueNormalizer<T> = LocalMapValueSanitizer<T>;

export function parseAuthorCacheMap<T>(
  raw: string | null,
  ttlMs: number,
  normalize: CacheValueNormalizer<T>,
  now = Date.now(),
): Map<string, T> | null {
  if (!raw) return null;
  try {
    return parseMapEnvelope(JSON.parse(raw), ttlMs, normalize, now);
  } catch {
    return null;
  }
}

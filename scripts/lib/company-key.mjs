import { createHash } from 'node:crypto';

const COMPANY_KEY_MAX_LENGTH = 64;
const COMPANY_KEY_HASH_LENGTH = 16;

export function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize a company key without making long names collide at the cut.
 *
 * Short keys keep their historical representation. Longer keys reserve room
 * for a deterministic digest of the complete normalized value; the retained
 * prefix is trimmed again so the separator introduced for the digest can
 * never be the last character of the key.
 */
export function normalizeCompanyKey(input) {
  const normalized = normalizeKey(input);
  if (normalized.length <= COMPANY_KEY_MAX_LENGTH) return normalized;

  const suffix = createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, COMPANY_KEY_HASH_LENGTH);
  const prefixLength = COMPANY_KEY_MAX_LENGTH - suffix.length - 1;
  const prefix = normalized.slice(0, prefixLength).replace(/-+$/, '');
  return prefix ? `${prefix}-${suffix}` : suffix;
}

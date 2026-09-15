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

/**
 * Normalize a persisted alias while preserving the trailing separator that
 * the old post-truncation normalizer could leave at character 64.
 */
export function normalizeCompanyKeyAlias(input = '') {
  const raw = String(input || '').trim();
  const normalized = normalizeKey(raw);
  if (!normalized) return '';
  return raw.endsWith('-') ? `${normalized}-` : normalized;
}

/**
 * Return the key emitted by the pre-digest normalizer for a long value.
 *
 * This is deliberately kept as a migration alias only. New records must use
 * normalizeCompanyKey(), while persisted jobs, adapter filenames and scoped
 * invocations may still carry this historical cut.
 */
export function legacyTruncatedCompanyKey(input = '') {
  const normalized = normalizeKey(input);
  return normalized.length > COMPANY_KEY_MAX_LENGTH
    ? normalized.slice(0, COMPANY_KEY_MAX_LENGTH)
    : '';
}

/**
 * Derive explicit aliases needed while moving a company to the digest key.
 *
 * The old key is derived from the full company name, never from an already
 * truncated key. An explicit key is retained too because extra-company data
 * and generated adapters may be the only place that still names the legacy
 * value.
 */
export function companyKeyAliasesFor(name = '', explicitKey = '') {
  const canonical = normalizeCompanyKey(name || explicitKey);
  const aliases = new Set();
  const add = (value) => {
    const alias = normalizeCompanyKeyAlias(value);
    if (alias && alias !== canonical) aliases.add(alias);
  };
  if (name) add(legacyTruncatedCompanyKey(name));
  if (explicitKey) {
    const explicitNormalized = normalizeKey(explicitKey);
    add(explicitNormalized.length > COMPANY_KEY_MAX_LENGTH
      ? legacyTruncatedCompanyKey(explicitNormalized)
      : explicitNormalized);
  }
  return [...aliases];
}

/**
 * Canonicalize a company definition and retain its old identifiers as aliases.
 * The full name has precedence over an existing key so a persisted 64-char
 * pre-digest key cannot suppress the new digest key.
 */
export function canonicalizeCompanyDefinition(company = {}) {
  const name = String(company?.name || '').trim();
  const explicitKey = String(company?.key || '').trim();
  const canonical = normalizeCompanyKey(name || explicitKey);
  const aliases = new Set([
    ...companyKeyAliasesFor(name, explicitKey),
    ...(Array.isArray(company?.companyKeyAliases) ? company.companyKeyAliases : []),
  ]);
  const normalizedAliases = [...aliases]
    .map((alias) => normalizeCompanyKeyAlias(alias))
    .filter((alias) => alias && alias !== canonical);
  return {
    ...company,
    key: canonical,
    ...(normalizedAliases.length > 0
      ? { companyKeyAliases: [...new Set(normalizedAliases)] }
      : {}),
  };
}

/**
 * Resolve the key used by the company-logo manifest.
 *
 * Resolve employer-scoped keys for multi-employer sources while preserving
 * municipality scope for the Ticino commune family. SECO/job-room rows carry
 * `companyLogoKey`; this helper also derives the same key for historical rows
 * that predate the field.
 */
import { slugify } from './slugify.mjs';
import {
  TICINO_COMUNI_FAMILY_KEY,
  scopedEmployerKey,
  ticinoComuneEmployerKey,
} from './ticino-comune-employer-identity.mjs';

export const EMPLOYER_SCOPED_LOGO_SOURCE_KEYS = Object.freeze(['seco-jobroom']);

export function companyLogoKeyFromEmployer(employer = '') {
  return slugify(employer);
}

export function companyLogoKeyForJob(job = {}) {
  const companyKey = String(job?.companyKey || '').trim();
  const rawMunicipalityKey = String(job?.municipalityKey || '').trim();
  const normalizedCompanyKey = companyKey.toLowerCase();
  const municipalityKey = ticinoComuneEmployerKey(rawMunicipalityKey);

  // Ticino municipality rows use the family key for storage, so their valid
  // municipality identity must win. An invalid or mismatched municipality
  // key must not fall back to the family key.
  if (
    normalizedCompanyKey === TICINO_COMUNI_FAMILY_KEY
    || (municipalityKey && normalizedCompanyKey === municipalityKey)
  ) {
    return scopedEmployerKey(job);
  }

  const explicit = String(job?.companyLogoKey || '').trim();
  const sharedSource = EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(normalizedCompanyKey);

  if (explicit && (!sharedSource || !EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(explicit))) {
    return explicit;
  }
  if (!sharedSource) return companyKey;
  return companyLogoKeyFromEmployer(job?.company || job?.employer || '');
}

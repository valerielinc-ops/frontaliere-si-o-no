/**
 * Resolve the key used by the company-logo manifest.
 *
 * Most crawlers have one company per `companyKey`, but SECO/job-room is a
 * public multi-employer register: its shared source key must never select one
 * employer's logo for another employer's ad. The parser writes
 * `companyLogoKey`; this helper also derives the same employer-scoped key for
 * historical rows that predate the field.
 */
import { slugify } from './slugify.mjs';

export const EMPLOYER_SCOPED_LOGO_SOURCE_KEYS = Object.freeze(['seco-jobroom']);

export function companyLogoKeyFromEmployer(employer = '') {
  return slugify(employer);
}

export function companyLogoKeyForJob(job = {}) {
  const companyKey = String(job?.companyKey || '').trim();
  const explicit = String(job?.companyLogoKey || '').trim();
  const sharedSource = EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(companyKey);

  if (explicit && (!sharedSource || !EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(explicit))) {
    return explicit;
  }
  if (!sharedSource) return companyKey;
  return companyLogoKeyFromEmployer(job?.company || job?.employer || '');
}

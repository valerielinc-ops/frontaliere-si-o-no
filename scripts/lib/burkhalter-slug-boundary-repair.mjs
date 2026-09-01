import { replaceActiveSlug } from './dedicated-crawler-common.mjs';
import { safeLocationToken } from './safe-location-token.mjs';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';

const BURKHALTER_SLUG_CAP = 120;
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalizeSlug(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fullSlugFor(job, title) {
  return normalizeSlug([
    title,
    job?.company,
    safeLocationToken(job?.addressLocality || job?.location || ''),
  ].filter(Boolean).join('-'));
}

function repairedSlug(current, full) {
  if (current.length !== BURKHALTER_SLUG_CAP || !full.startsWith(current)) return '';
  const repaired = truncateSlugAtWordBoundary(full, BURKHALTER_SLUG_CAP);
  return repaired !== current ? repaired : '';
}

/**
 * Migrate only slugs that are provably the exact legacy 120-character prefix
 * of the same localized title/company/location identity. This avoids treating
 * ordinary wording changes as a repair while retiring the broken route through
 * replaceActiveSlug(), which records locale-aware redirect history.
 *
 * @param {object} job
 * @returns {number} number of active slug fields repaired
 */
export function repairBurkhalterBoundarySlugs(job) {
  if (!job || typeof job !== 'object') return 0;

  const beforeFlat = String(job.slug || '').trim();
  const replacements = new Map();
  let repairedCount = 0;

  for (const locale of LOCALES) {
    const current = String(job.slugByLocale?.[locale] || '').trim();
    const title = String(job.titleByLocale?.[locale] || '').trim();
    if (!current || !title) continue;

    const next = repairedSlug(current, fullSlugFor(job, title));
    if (!next) continue;
    replacements.set(locale, { current, next });
    if (replaceActiveSlug(job, next, { locale })) repairedCount += 1;
  }

  const preferredFlatLocales = ['it', String(job.sourceLang || '').toLowerCase(), ...LOCALES];
  for (const locale of preferredFlatLocales) {
    const replacement = replacements.get(locale);
    if (!replacement || replacement.current !== beforeFlat) continue;
    if (replaceActiveSlug(job, replacement.next)) repairedCount += 1;
    return repairedCount;
  }

  // Legacy rows can predate slugByLocale. In that case the source title is
  // still sufficient proof, but only when the active slug is its exact prefix.
  const sourceRepair = repairedSlug(beforeFlat, fullSlugFor(job, job.title));
  if (sourceRepair && replaceActiveSlug(job, sourceRepair)) repairedCount += 1;
  return repairedCount;
}

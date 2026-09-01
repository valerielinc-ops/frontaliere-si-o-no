import { assembleUrlKey, identityUrlKey } from './job-url-key.mjs';
import { stableStringify } from './stable-stringify.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

// Identity URL normalization now lives in the shared scripts/lib/job-url-key.mjs
// (identityUrlKey variant) alongside the crawl-time merge key and the
// assemble-time dedup key, so all three are visible — and their intentional
// divergences documented — in one place. Behavior unchanged; pinned by
// tests/job-url-key.test.ts.
function normalizeIdentityUrl(value = '') {
  return identityUrlKey(value);
}

function normalizeLocaleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (Array.isArray(inner)) {
      out[key] = inner.map((item) => normalizeSpace(item)).filter(Boolean);
    } else {
      out[key] = normalizeSpace(inner);
    }
  }
  return out;
}

function identityFallback(job = {}) {
  return stableStringify({
    title: normalizeSpace(job.title || ''),
    company: normalizeSpace(job.company || ''),
    location: normalizeSpace(job.location || ''),
  });
}

export function buildStableJobIdentity(job = {}) {
  const rawUrl = normalizeIdentityUrl(job.url || '');
  if (rawUrl) return `url:${rawUrl}`;

  const rawId = normalizeSpace(job.id || job.externalId || job.jobId || '');
  if (rawId) return `id:${rawId.toLowerCase()}`;

  const rawSlug = normalizeSpace(job.slug || job.slugByLocale?.it || '');
  if (rawSlug) return `slug:${rawSlug.toLowerCase()}`;

  return `fallback:${identityFallback(job)}`;
}

/**
 * Identity of a record in the assembled jobs population.
 *
 * URL keys deliberately retain hash fragments, matching the assembler's
 * deduplication semantics. Other identity fallbacks remain stable-job keys.
 */
export function buildAssembledJobIdentity(job = {}) {
  const rawUrl = assembleUrlKey(job.url);
  if (rawUrl) return `url:${rawUrl}`;
  return buildStableJobIdentity(job);
}

export function comparableJobShape(job = {}) {
  return {
    title: normalizeSpace(job.title || ''),
    company: normalizeSpace(job.company || ''),
    companyKey: normalizeSpace(job.companyKey || ''),
    location: normalizeSpace(job.location || ''),
    canton: normalizeSpace(job.canton || ''),
    url: normalizeSpace(job.url || ''),
    applyUrl: normalizeSpace(job.applyUrl || ''),
    slug: normalizeSpace(job.slug || ''),
    description: normalizeSpace(job.description || ''),
    requirements: safeArray(job.requirements).map((item) => normalizeSpace(item)).filter(Boolean),
    postedDate: normalizeSpace(job.postedDate || ''),
    contract: normalizeSpace(job.contract || ''),
    category: normalizeSpace(job.category || ''),
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    titleByLocale: normalizeLocaleMap(job.titleByLocale),
    descriptionByLocale: normalizeLocaleMap(job.descriptionByLocale),
    requirementsByLocale: normalizeLocaleMap(job.requirementsByLocale),
    slugByLocale: normalizeLocaleMap(job.slugByLocale),
  };
}

export function jobsDiffer(previousJob = {}, currentJob = {}) {
  return stableStringify(comparableJobShape(previousJob)) !== stableStringify(comparableJobShape(currentJob));
}

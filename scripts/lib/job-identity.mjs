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
 * Source-posting identities an expired archive record declares: its own URL
 * when present, the `sourceIdentity` written by the archivers, and every
 * identity a dedup merge recorded in `sourceIdentityHistory`.
 *
 * @param {object} expiredJob archive record
 * @returns {Set<string>} stable-job identities (possibly empty)
 */
export function archiveRecordSourceIdentities(expiredJob = {}) {
  const ids = new Set();
  const add = (value) => {
    const id = normalizeSpace(value ?? '');
    if (id) ids.add(id);
  };
  if (normalizeSpace(expiredJob?.url ?? '')) add(buildStableJobIdentity(expiredJob));
  add(expiredJob?.sourceIdentity);
  const history = Array.isArray(expiredJob?.sourceIdentityHistory) ? expiredJob.sourceIdentityHistory : [];
  for (const entry of history) add(entry?.sourceIdentity);
  return ids;
}

/**
 * Whether an expired archive record may describe `activeJob`'s posting.
 *
 * Merging an archive record's routes into an active job is only correct when
 * both describe the SAME posting. A record that names its source posting and
 * does not name the active job is a different posting that merely shares
 * title/company/location (typically a sibling vacancy archived as a dedup
 * duplicate); merging it hands the active job another posting's routes,
 * hash-tailed slug included (#11596). When the active job has a URL but the
 * archive has no source identity, the evidence is ambiguous and must fail
 * closed. The legacy fallback remains only for records where neither side has
 * a stable identity, because the caller's exact route/title/company/location
 * evidence is the only available proof in that deliberately bounded case.
 *
 * @param {object} expiredJob archive record
 * @param {object} activeJob candidate active owner
 * @returns {boolean}
 */
export function archiveRecordNamesPosting(expiredJob = {}, activeJob = {}) {
  const expiredIds = archiveRecordSourceIdentities(expiredJob);
  const activeUrl = normalizeSpace(activeJob?.url ?? '');
  if (expiredIds.size === 0) return !activeUrl;
  if (!activeUrl) return true;
  return expiredIds.has(buildStableJobIdentity(activeJob));
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

/** Normalize a source-posting URL exactly as the positive-identity guard does. */
export function sourcePostingUrlHref(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch { return null; }
}

/**
 * URL identities declared by an orphan or archive record.
 * Keeps path case and fragments, matching the positive-identity guard.
 */
export function sourcePostingUrlHrefs(historical = {}) {
  const source = historical && typeof historical === 'object' ? historical : {};
  const sourceUrls = [source.sourceUrl, source.url];
  const identities = [source.sourceIdentity, ...safeArray(source.sourceIdentityHistory).map((entry) => entry?.sourceIdentity)];
  for (const identity of identities) {
    if (typeof identity === 'string' && identity.startsWith('url:')) sourceUrls.push(identity.slice(4));
  }
  return new Set(sourceUrls.map(sourcePostingUrlHref).filter(Boolean));
}

/** Positive posting proof for inferred slug aliases; similar titles are not identity. */
export function hasSameJobSourcePosting(historical = {}, active = {}) {
  const targetHref = sourcePostingUrlHref(active.url);
  if (!targetHref) return false;
  // Unlike legacy dedup keys, positive proof preserves path case AND fragments.
  // /AbC and /abc, or two #job.id values, can name different vacancies.
  return sourcePostingUrlHrefs(historical).has(targetHref);
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

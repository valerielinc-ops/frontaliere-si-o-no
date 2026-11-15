import { hasSameJobSourcePosting as defaultHasSameJobSourcePosting } from './job-identity.mjs';

const HASH_TRAILER_RE = /-[a-z0-9]{4,8}$/;
const SKIP_PREFIX_FUZZY = /^(?:search|ricerca|suche|recherche|azienda|company|unternehmen|entreprise)-/;

// Hash trailers like "-w5vlie" are per-posting noise — strip them before
// tokenizing so they do not drown out the discriminant tokens (department,
// city).
function tokenize(s) {
  return String(s || '')
    .replace(HASH_TRAILER_RE, '')
    .split('-')
    .filter((token) => token.length >= 3);
}

// The canonical location is a hard lock. A fuzzy title overlap alone is not
// enough to attribute an orphan to a live job in another city.
function cityTokens(location) {
  if (typeof location !== 'string' || !location) return [];
  return location
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function releaseFuzzyIndexes(knownSlugs, jobsByToken, jobCityTokens) {
  const released = {
    fuzzyKnownSlugEntries: knownSlugs.size,
    fuzzyJobTokenEntries: jobsByToken.size,
    fuzzyJobCityRows: jobCityTokens.length,
  };
  knownSlugs.clear();
  jobsByToken.clear();
  jobCityTokens.length = 0;
  return released;
}

/**
 * Infer locale-specific previous slugs only when the orphan and active job
 * identify the same source posting.
 *
 * The returned releaseIndexes callback is intentionally kept when
 * retainIndexes is true. The jobs SEO plugin uses that opt-in probe to measure
 * the retained index set at its final corpus-release checkpoint.
 */
export function inferOrphanSlugAliases({
  validJobs,
  tracking,
  orphanGscData,
  localeList,
  hasSameJobSourcePosting = defaultHasSameJobSourcePosting,
  addPreviousSlugForLocale,
  retainIndexes = false,
}) {
  if (typeof addPreviousSlugForLocale !== 'function') {
    throw new TypeError('inferOrphanSlugAliases requires an explicit alias mutation callback');
  }

  const knownSlugs = new Set();
  for (const job of validJobs) {
    if (job.slug) knownSlugs.add(job.slug);
    if (job.slugByLocale) {
      for (const slug of Object.values(job.slugByLocale)) {
        if (typeof slug === 'string' && slug) knownSlugs.add(slug);
      }
    }
    const previousSlugs = Array.isArray(job.previousSlugs) ? job.previousSlugs : [];
    for (const slug of previousSlugs) knownSlugs.add(slug);
    if (job.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
      for (const slugs of Object.values(job.previousSlugsByLocale)) {
        if (Array.isArray(slugs)) {
          for (const slug of slugs) knownSlugs.add(slug);
        }
      }
    }
  }

  const jobCityTokens = validJobs.map((job) => cityTokens(job.location));
  const jobsByToken = new Map();
  validJobs.forEach((job, index) => {
    const slugByLocale = job.slugByLocale || {};
    const allJobSlugs = [
      ...Object.values(slugByLocale).filter((slug) => typeof slug === 'string' && slug.length > 0),
      job.slug,
    ].filter(Boolean);
    const tokens = new Set();
    for (const slug of allJobSlugs) {
      for (const token of tokenize(slug)) tokens.add(token);
    }
    for (const token of tokens) {
      if (!jobsByToken.has(token)) jobsByToken.set(token, new Set());
      jobsByToken.get(token).add(index);
    }
  });

  let fuzzyMatched = 0;
  let cityLockRejections = 0;
  for (const orphanSlug of Object.keys(tracking)) {
    if (knownSlugs.has(orphanSlug)) continue;
    if (SKIP_PREFIX_FUZZY.test(orphanSlug)) continue;
    const orphanProof = orphanGscData.get(orphanSlug);
    if (!orphanProof?.sourceUrl) continue;
    const orphanTokens = tokenize(orphanSlug);
    if (orphanTokens.length < 4) continue;
    const orphanTokenSet = new Set(orphanTokens);
    const candidateIdx = new Map();
    for (const token of orphanTokens) {
      const indexes = jobsByToken.get(token);
      if (!indexes) continue;
      for (const index of indexes) {
        candidateIdx.set(index, (candidateIdx.get(index) || 0) + 1);
      }
    }
    if (candidateIdx.size === 0) continue;

    let best = null;
    for (const [index, shared] of candidateIdx) {
      if (shared < 3) continue;
      const candidateCityTokens = jobCityTokens[index];
      if (candidateCityTokens.length === 0) {
        cityLockRejections++;
        continue;
      }
      if (!candidateCityTokens.every((token) => orphanTokenSet.has(token))) {
        cityLockRejections++;
        continue;
      }
      const candidate = validJobs[index];
      // Company/city words can dominate overlap across specialties. Never
      // turn an oncology URL into a live orthopedics vacancy without identity.
      if (!hasSameJobSourcePosting(orphanProof, candidate)) continue;
      const slugByLocale = candidate.slugByLocale || {};
      for (const locale of localeList) {
        const candidateSlug = slugByLocale[locale] || candidate.slug || '';
        if (!candidateSlug) continue;
        const candidateTokens = new Set(tokenize(candidateSlug));
        if (candidateTokens.size === 0) continue;
        const intersection = orphanTokens.filter((token) => candidateTokens.has(token)).length;
        const score = intersection / Math.max(orphanTokens.length, candidateTokens.size);
        if (!best || score > best.score) {
          best = { job: candidate, locale, score, shared: intersection };
        }
      }
    }

    if (!best || best.score < 0.6 || best.shared < 3) continue;
    const target = best.job;
    const aliases = Array.isArray(target.previousSlugsByLocale?.[best.locale])
      ? target.previousSlugsByLocale[best.locale]
      : [];
    if (aliases.includes(orphanSlug)) continue;
    addPreviousSlugForLocale(target, best.locale, orphanSlug, undefined, 'orphan-slug-fuzzy-match');
    knownSlugs.add(orphanSlug);
    fuzzyMatched++;
  }

  let releaseIndexes;
  let releasedIndexes = null;
  const retainedIndexes = retainIndexes ? { jobsByToken, jobCityTokens } : null;
  if (retainIndexes) {
    releaseIndexes = () => {
      if (!releaseIndexes) return null;
      const released = releaseFuzzyIndexes(knownSlugs, jobsByToken, jobCityTokens);
      releaseIndexes = null;
      return released;
    };
  } else {
    releasedIndexes = releaseFuzzyIndexes(knownSlugs, jobsByToken, jobCityTokens);
  }

  return {
    fuzzyMatched,
    cityLockRejections,
    releasedIndexes,
    releaseIndexes,
    retainedIndexes,
  };
}

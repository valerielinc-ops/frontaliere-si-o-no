import { createHash } from 'node:crypto';
import { buildStableJobIdentity } from './job-identity.mjs';
import { stableStringify } from './stable-stringify.mjs';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';

function confirmedDuplicateIdentity(left, right) {
  const leftIdentity = buildStableJobIdentity(left);
  const rightIdentity = buildStableJobIdentity(right);
  const leftHasUrl = leftIdentity.startsWith('url:');
  const rightHasUrl = rightIdentity.startsWith('url:');
  if (leftHasUrl || rightHasUrl) {
    // URL evidence must agree on both records. Equal vendor IDs cannot
    // collapse two still-published jobs at different source URLs.
    return leftHasUrl && rightHasUrl && leftIdentity === rightIdentity;
  }
  return leftIdentity.startsWith('id:')
    && rightIdentity.startsWith('id:')
    && leftIdentity === rightIdentity;
}

function text(value) {
  return String(value ?? '').trim();
}

function disambiguateActiveSlug(job, { ordinal, collisionAttempt = 0 }) {
  const title = text(job?.titleByLocale?.it || job?.title);
  const company = text(job?.company);
  const locality = text(job?.addressLocality || job?.location);
  const base = [title, company, locality]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  const identity = buildStableJobIdentity(job);
  const hasStableSourceIdentity = identity.startsWith('url:') || identity.startsWith('id:');
  const suffix = createHash('sha256')
    .update(stableStringify({
      identity,
      id: text(job?.id || job?.externalId || job?.jobId),
      url: text(job?.url),
      title,
      company,
      locality,
      ordinal: hasStableSourceIdentity ? null : ordinal,
      collisionAttempt,
    }))
    .digest('hex')
    .slice(0, 10);
  const limit = 140 - suffix.length - 1;
  const prefix = truncateSlugAtWordBoundary(base || 'annuncio', limit).replace(/-+$/g, '');
  const slug = `${prefix || 'annuncio'}-${suffix}`;
  const previousSlugs = Array.isArray(job?.previousSlugs) ? [...job.previousSlugs] : [];
  const previousSlugsByLocale = job?.previousSlugsByLocale
    && typeof job.previousSlugsByLocale === 'object'
    ? Object.fromEntries(
      Object.entries(job.previousSlugsByLocale).map(([locale, values]) => [
        locale,
        Array.isArray(values) ? [...values] : [],
      ]),
    )
    : {};
  const originalItalianSlug = text(job?.slugByLocale?.it || job?.slug);
  const addPreviousSlug = (value) => {
    if (!value || value === slug) return;
    if (!previousSlugs.includes(value)) previousSlugs.push(value);
    const italianHistory = Array.isArray(previousSlugsByLocale.it)
      ? previousSlugsByLocale.it
      : (previousSlugsByLocale.it = []);
    if (!italianHistory.includes(value)) italianHistory.push(value);
  };
  addPreviousSlug(originalItalianSlug);
  return {
    ...job,
    slug,
    slugByLocale: { ...(job?.slugByLocale || {}), it: slug },
    previousSlugs,
    previousSlugsByLocale,
  };
}

/**
 * Collapse only records with proven source identity. Distinct postings that
 * happen to share a slug remain active and get deterministic Italian routes.
 *
 * @param {object[]} jobs jobs in the caller's preferred order
 * @param {{preferCurrent?: (current: object, previous: object) => boolean, disambiguateFirst?: boolean}} options
 * @returns {{jobs: object[], duplicates: object[], distinctCollisions: object[], distinctPostingCount: number}}
 */
export function deduplicateJobsBySlug(
  jobs,
  { preferCurrent = () => false, disambiguateFirst = true } = {},
) {
  const groups = new Map();
  const duplicates = [];
  const distinctCollisions = [];
  const outputByIndex = new Map();
  const pendingDisambiguations = [];

  (Array.isArray(jobs) ? jobs : []).forEach((job, index) => {
    const slug = text(job?.slug);
    if (!slug) {
      outputByIndex.set(index, job);
      return;
    }

    let group = groups.get(slug);
    if (!group) {
      group = [];
      groups.set(slug, group);
    }
    const duplicate = group.find((entry) => confirmedDuplicateIdentity(entry.job, job));
    if (duplicate) {
      const currentWins = preferCurrent(job, duplicate.job);
      const winner = currentWins ? job : duplicate.job;
      const loser = currentWins ? duplicate.job : job;
      duplicate.job = winner;
      duplicates.push({ loser, winner, slug });
      return;
    }

    if (group.length > 0) {
      distinctCollisions.push({ slug, id: job?.id || job?.url || 'unknown' });
    }
    group.push({ job, index });
  });

  const usedRoutes = new Set();
  for (const [slug, group] of groups) {
    if (group.length === 1) {
      outputByIndex.set(group[0].index, group[0].job);
      usedRoutes.add(slug);
      continue;
    }
    group.forEach((entry, ordinal) => {
      const keepOriginal = !disambiguateFirst && ordinal === 0;
      if (keepOriginal) {
        outputByIndex.set(entry.index, entry.job);
        usedRoutes.add(slug);
      } else {
        pendingDisambiguations.push({ ...entry, ordinal });
      }
    });
  }

  for (const entry of pendingDisambiguations) {
    let collisionAttempt = 0;
    let job;
    do {
      job = disambiguateActiveSlug(entry.job, { ordinal: entry.ordinal, collisionAttempt });
      collisionAttempt += 1;
    } while (usedRoutes.has(job.slug));
    outputByIndex.set(entry.index, job);
    usedRoutes.add(job.slug);
  }

  const resultJobs = [...outputByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, job]) => job);
  const distinctPostingCount = [...groups.values()]
    .filter((group) => group.length > 1)
    .reduce((total, group) => total + group.length, 0);

  return { jobs: resultJobs, duplicates, distinctCollisions, distinctPostingCount };
}

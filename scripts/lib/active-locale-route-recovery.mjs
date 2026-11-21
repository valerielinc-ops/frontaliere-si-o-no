export const JOB_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const DEFAULT_LOCALE_HISTORY_CAP = 20;
export const LEGACY_HISTORY_CAP = 80;

const objectLike = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;

export function isStrongJobFingerprint(fingerprint) {
  return typeof fingerprint === 'string'
    && (fingerprint.startsWith('id|') || fingerprint.startsWith('url|'));
}

/** Exact owner keys from immutable source identity fields. */
export function stableJobIdentityKeys(job, fingerprintOf) {
  const keys = [];
  const id = String(job?.id || '').trim();
  if (id) keys.push(`job-id|${id}`);
  const fingerprint = typeof fingerprintOf === 'function' ? fingerprintOf(job) : '';
  if (isStrongJobFingerprint(fingerprint)) keys.push(`job-fingerprint|${fingerprint}`);
  const url = String(job?.url || '').trim();
  if (url) keys.push(`job-url|${url}`);
  return [...new Set(keys)];
}

/** The primary exact owner key, useful for diagnostics and revalidation. */
export function stableJobIdentity(job, fingerprintOf) {
  return stableJobIdentityKeys(job, fingerprintOf)[0] || '';
}

function addOwner(ownersByRoute, routePath, ownerId) {
  const owners = ownersByRoute.get(routePath) || new Set();
  owners.add(ownerId);
  ownersByRoute.set(routePath, owners);
}

function servedSlug(job, locale, includeDerivedActiveSlug) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  const canonical = String(job?.slug || '').trim();
  if (canonical) return canonical;
  if (!includeDerivedActiveSlug) return '';
  const source = String(job?.titleByLocale?.[locale] || job?.title || '');
  const suffix = [job?.company, job?.location].filter(nonblank).join(' ');
  return slugify(`${source} ${suffix}`) || slugify(source);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function historyValuesByLocale(job, locale) {
  const history = objectLike(job?.previousSlugsByLocale) ? job.previousSlugsByLocale : {};
  const localeAware = new Set();
  for (const values of Object.values(history)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (nonblank(value)) localeAware.add(value);
  }
  const localeSpecific = Array.isArray(history[locale]) ? history[locale] : [];
  const legacyOnly = Array.isArray(job?.previousSlugs)
    ? job.previousSlugs.filter((value) => nonblank(value) && !localeAware.has(value))
    : [];
  return [...localeSpecific, ...legacyOnly];
}

export function addServedRoutePaths(target, rows, {
  routeFor,
  isHeld = () => false,
  includeDerivedActiveSlug = true,
} = {}) {
  if (!(target instanceof Set) || !Array.isArray(rows) || typeof routeFor !== 'function') {
    throw new TypeError('invalid served route inputs');
  }
  for (const row of rows) {
    const job = row?.job || row;
    if (!job || isHeld(job)) continue;
    for (const locale of JOB_LOCALES) {
      const current = servedSlug(job, locale, includeDerivedActiveSlug);
      if (nonblank(current)) target.add(routeFor(job, locale, current));
      for (const value of historyValuesByLocale(job, locale)) {
        if (nonblank(value)) target.add(routeFor(job, locale, value));
      }
    }
  }
  return target;
}

export function collectServedRoutePaths(rows, {
  routeFor,
  isHeld = () => false,
  includeDerivedActiveSlug = true,
} = {}) {
  if (!Array.isArray(rows) || typeof routeFor !== 'function') throw new TypeError('invalid served route inputs');
  return addServedRoutePaths(new Set(), rows, {
    routeFor,
    isHeld,
    includeDerivedActiveSlug,
  });
}

function currentHistory(job, locale) {
  const history = job?.previousSlugsByLocale;
  if (history !== undefined && !objectLike(history)) return { malformed: true };
  const bucket = history?.[locale];
  if (bucket !== undefined && !Array.isArray(bucket)) return { malformed: true };
  const flat = job?.previousSlugs;
  if (flat !== undefined && !Array.isArray(flat)) return { malformed: true };
  return {
    malformed: false,
    bucket: Array.isArray(bucket) ? bucket : [],
    flat: Array.isArray(flat) ? flat : [],
  };
}

function ownerIdOf(row) {
  return row?.ownerId || `${row?.file || row?.fileName || ''}\u0000${row?.index ?? ''}`;
}

function fileNameOf(row) {
  return row?.fileName || String(row?.file || '').split('/').pop() || '';
}

/**
 * Plan recovery of explicit locale routes from a base active snapshot.
 * Identity comes only from immutable id/url evidence and the stable job
 * fingerprint; no title or slug similarity is used.
 */
export function planActiveLocaleRouteRecovery({
  baseRows,
  headRows,
  routeFor,
  fingerprintOf,
  denylist = new Set(),
  localeCap = DEFAULT_LOCALE_HISTORY_CAP,
  legacyCap = LEGACY_HISTORY_CAP,
  isHeld = () => false,
  servedRoutes,
}) {
  if (!Array.isArray(baseRows) || !Array.isArray(headRows)
    || typeof routeFor !== 'function' || typeof fingerprintOf !== 'function'
    || !(denylist instanceof Set) || typeof isHeld !== 'function') {
    throw new TypeError('invalid active locale route recovery inputs');
  }
  if (!Number.isSafeInteger(localeCap) || localeCap < 1
    || !Number.isSafeInteger(legacyCap) || legacyCap < 1) {
    throw new TypeError('invalid active locale route caps');
  }

  const summary = {
    baseRows: 0,
    baseLocaleRoutes: 0,
    headRows: headRows.length,
    skippedByReason: {},
  };
  const skip = (reason) => {
    summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + 1;
  };

  const headByIdentity = new Map();
  const headPublishedRows = [];
  for (const row of headRows) {
    const job = row?.job || row;
    if (!job || isHeld(job)) continue;
    headPublishedRows.push(row);
    const identities = stableJobIdentityKeys(job, () => row?.fingerprint || fingerprintOf(job));
    for (const identity of identities) {
      const group = headByIdentity.get(identity) || [];
      group.push(row);
      headByIdentity.set(identity, group);
    }
  }

  const served = servedRoutes instanceof Set
    ? servedRoutes
    : collectServedRoutePaths(headPublishedRows, { routeFor, isHeld });
  const candidates = [];
  for (const baseRow of baseRows) {
    summary.baseRows += 1;
    const baseJob = baseRow?.job || baseRow;
    if (!baseJob || isHeld(baseJob)) {
      if (baseJob) skip('held');
      continue;
    }
    const fingerprint = baseRow?.fingerprint || fingerprintOf(baseJob);
    const identities = stableJobIdentityKeys(baseJob, () => fingerprint);
    if (identities.length === 0) {
      for (const [locale, value] of Object.entries(baseJob.slugByLocale || {})) {
        if (JOB_LOCALES.includes(locale) && nonblank(value)) {
          summary.baseLocaleRoutes += 1;
          skip('weakFingerprint');
        }
      }
      continue;
    }

    const ownersById = new Map();
    for (const identity of identities) {
      for (const row of headByIdentity.get(identity) || []) ownersById.set(ownerIdOf(row), row);
    }
    const owners = [...ownersById.values()];
    for (const [locale, rawSlug] of Object.entries(baseJob.slugByLocale || {})) {
      if (!JOB_LOCALES.includes(locale) || !nonblank(rawSlug)) continue;
      summary.baseLocaleRoutes += 1;
      const slug = rawSlug.trim();
      let baseRoute;
      try {
        baseRoute = routeFor(baseJob, locale, slug);
      } catch {
        skip('invalidBaseRoute');
        continue;
      }
      if (served.has(baseRoute)) {
        skip('alreadyCovered');
        continue;
      }
      if (owners.length === 0) {
        skip('missingHeadOwner');
        continue;
      }
      if (owners.length !== 1) {
        skip('ambiguousHeadOwner');
        continue;
      }
      const headRow = owners[0];
      const headJob = headRow.job || headRow;
      let headRoute;
      try {
        headRoute = routeFor(headJob, locale, slug);
      } catch {
        skip('invalidHeadRoute');
        continue;
      }
      if (headRoute !== baseRoute) {
        skip('routeContextChanged');
        continue;
      }
      candidates.push({
        baseRoute,
        file: headRow.file,
        fileName: fileNameOf(headRow),
        index: headRow.index,
        locale,
        ownerId: ownerIdOf(headRow),
        fingerprint,
        identity: identities.find((identity) => (headByIdentity.get(identity) || [])
          .some((row) => ownerIdOf(row) === ownerIdOf(headRow))) || '',
        slug,
        job: headJob,
      });
    }
  }

  const candidatesByRoute = new Map();
  const candidatesByTarget = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.ownerId}\u0000${candidate.locale}\u0000${candidate.slug}`;
    const targetGroup = candidatesByTarget.get(key) || [];
    targetGroup.push(candidate);
    candidatesByTarget.set(key, targetGroup);
    addOwner(candidatesByRoute, candidate.baseRoute, candidate.ownerId);
  }

  const actions = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.ownerId}\u0000${candidate.locale}\u0000${candidate.slug}`;
    if (seen.has(key)) {
      skip('duplicateCandidate');
      continue;
    }
    seen.add(key);
    if ((candidatesByTarget.get(key)?.length || 0) > 1) {
      skip('duplicateCandidate');
      continue;
    }
    const routeOwners = candidatesByRoute.get(candidate.baseRoute) || new Set();
    if (routeOwners.size > 1) {
      skip('candidateRouteCollision');
      continue;
    }
    if (denylist.has(`${candidate.fileName}\u0000${candidate.slug}`)) {
      skip('denylisted');
      continue;
    }
    if (served.has(candidate.baseRoute)) {
      skip('alreadyCovered');
      continue;
    }
    const history = currentHistory(candidate.job, candidate.locale);
    if (history.malformed) {
      skip('malformedHistory');
      continue;
    }
    if (history.bucket.includes(candidate.slug)) {
      skip('alreadyInLocaleHistory');
      continue;
    }
    if (history.bucket.length >= localeCap) {
      skip('localeCap');
      continue;
    }
    const includeFlat = !history.flat.includes(candidate.slug) && history.flat.length < legacyCap;
    actions.push({
      ...candidate,
      includeFlat,
      flatOmitted: !includeFlat,
    });
  }

  const byCrawlerLocale = {};
  for (const action of actions) {
    const crawler = action.fileName.endsWith('.json')
      ? action.fileName.slice(0, -5)
      : action.fileName;
    byCrawlerLocale[crawler] ||= {};
    byCrawlerLocale[crawler][action.locale] = (byCrawlerLocale[crawler][action.locale] || 0) + 1;
  }
  summary.recoverable = actions.length;
  summary.filesToChange = new Set(actions.map((action) => action.file)).size;
  summary.flatLegacyAdds = actions.filter((action) => action.includeFlat).length;
  summary.flatLegacyOmitted = actions.filter((action) => action.flatOmitted).length;
  actions.sort((left, right) => (
    fileNameOf(left).localeCompare(fileNameOf(right))
      || left.index - right.index
      || left.locale.localeCompare(right.locale)
      || left.slug.localeCompare(right.slug)
  ));
  summary.byCrawlerLocale = byCrawlerLocale;
  return { actions, summary };
}

export function applyActiveLocaleRouteAlias(job, action, {
  localeCap = DEFAULT_LOCALE_HISTORY_CAP,
  legacyCap = LEGACY_HISTORY_CAP,
} = {}) {
  if (!job || !action || typeof action.locale !== 'string' || typeof action.slug !== 'string') {
    throw new TypeError('invalid active locale route action');
  }
  const history = currentHistory(job, action.locale);
  if (history.malformed) throw new Error('malformed history');
  if (history.bucket.includes(action.slug)) throw new Error('locale history already contains alias');
  if (history.bucket.length >= localeCap) throw new Error('locale history cap reached');
  if (action.includeFlat && history.flat.length >= legacyCap && !history.flat.includes(action.slug)) {
    throw new Error('legacy history cap reached');
  }

  if (!job.previousSlugsByLocale) job.previousSlugsByLocale = {};
  if (!Array.isArray(job.previousSlugsByLocale[action.locale])) {
    job.previousSlugsByLocale[action.locale] = [];
  }
  job.previousSlugsByLocale[action.locale].push(action.slug);
  if (action.includeFlat) {
    if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
    if (!job.previousSlugs.includes(action.slug)) job.previousSlugs.push(action.slug);
  }
  return job;
}

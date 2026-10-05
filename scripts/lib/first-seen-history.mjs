import { buildStableJobIdentity } from './job-identity.mjs';

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function usableTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function routeSlugs(record = {}) {
  const slugs = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) slugs.add(value.trim().toLowerCase());
  };
  add(record.slug);
  for (const value of Object.values(record.slugByLocale || {})) add(value);
  for (const value of record.previousSlugs || []) add(value);
  for (const values of Object.values(record.previousSlugsByLocale || {})) {
    for (const value of values || []) add(value);
  }
  return slugs;
}

function indexEntry(index, key, entry) {
  if (!key) return;
  const entries = index.get(key) || [];
  entries.push(entry);
  index.set(key, entries);
}

function addRecordToIndexes(record, byIdentity, bySlug) {
  const identityRecords = [record];
  for (const history of Array.isArray(record?.sourceIdentityHistory) ? record.sourceIdentityHistory : []) {
    if (!history?.sourceIdentity) continue;
    identityRecords.push({
      ...record,
      sourceIdentity: history.sourceIdentity,
      firstSeenAt: history.firstSeenAt || record.firstSeenAt,
      title: history.title || record.title,
    });
  }
  for (const identityRecord of identityRecords) {
    const identity = identityRecord?.sourceIdentity || buildStableJobIdentity(identityRecord);
    if (identity) indexEntry(byIdentity, identity, identityRecord);
  }
  for (const slug of routeSlugs(record)) indexEntry(bySlug, `slug:${slug}`, record);
}

function samePostingTitle(job, archived) {
  const current = normalizeTitle(job?.title);
  const previous = normalizeTitle(archived?.title);
  // Missing titles do not disqualify a stable source identity. When both are
  // present, an exact source-title match protects against an ATS reusing the
  // same requisition URL for a different posting.
  return !current || !previous || current === previous;
}

function findMatchingEntry(entries, job) {
  return (entries || []).find((entry) => samePostingTitle(job, entry)) || null;
}

function earlierTimestamp(a, b) {
  if (!usableTimestamp(a)) return b;
  if (!usableTimestamp(b)) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function addExistingHistory(record, byIdentity, bySlug) {
  if (!usableTimestamp(record?.firstSeenAt)) return;
  addRecordToIndexes(record, byIdentity, bySlug);
}

function historicalCandidate(record = {}) {
  return {
    title: record.title || '',
    slug: record.slug || '',
    slugByLocale: record.slugByLocale || {},
    previousSlugs: Array.isArray(record.previousSlugs) ? [...record.previousSlugs] : [],
    previousSlugsByLocale: record.previousSlugsByLocale || {},
    sourceIdentity: record.sourceIdentity || buildStableJobIdentity(record),
    firstSeenAt: record.firstSeenAt,
  };
}

function candidateKey(candidate) {
  return `${candidate.sourceIdentity}\u0000${normalizeTitle(candidate.title)}`;
}

function preferHistoricalCandidate(current, incoming) {
  if (!current) return incoming;
  const currentHasTimestamp = usableTimestamp(current.firstSeenAt);
  const incomingHasTimestamp = usableTimestamp(incoming.firstSeenAt);
  if (incomingHasTimestamp && !currentHasTimestamp) return incoming;
  if (currentHasTimestamp && !incomingHasTimestamp) return current;
  if (incomingHasTimestamp && currentHasTimestamp) {
    return Date.parse(incoming.firstSeenAt) < Date.parse(current.firstSeenAt)
      ? incoming
      : current;
  }
  return current.sourceIdentity ? current : incoming;
}

/**
 * Build a compact index while walking Git history. It keeps only the fields
 * needed to enrich legacy expired entries, so a full historical slice is not
 * retained in memory.
 */
export function createFirstSeenMetadataIndex() {
  const byIdentity = new Map();
  const bySlug = new Map();

  function addCandidateToIndex(index, key, candidate) {
    if (!key) return;
    const candidates = index.get(key) || [];
    const keyForCandidate = candidateKey(candidate);
    const existingIndex = candidates.findIndex((item) => candidateKey(item) === keyForCandidate);
    if (existingIndex >= 0) {
      candidates[existingIndex] = preferHistoricalCandidate(candidates[existingIndex], candidate);
    } else {
      candidates.push(candidate);
    }
    index.set(key, candidates);
  }

  function add(record) {
    if (!record || typeof record !== 'object') return;
    const candidate = historicalCandidate(record);
    if (candidate.sourceIdentity) {
      addCandidateToIndex(byIdentity, candidate.sourceIdentity, candidate);
    }
    for (const slug of routeSlugs(candidate)) {
      addCandidateToIndex(bySlug, `slug:${slug}`, candidate);
    }
  }

  function findMatches(entry) {
    const candidates = [];
    if (entry?.sourceIdentity) {
      candidates.push(...(byIdentity.get(entry.sourceIdentity) || []));
    }
    for (const slug of routeSlugs(entry)) {
      candidates.push(...(bySlug.get(`slug:${slug}`) || []));
    }
    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = candidateKey(candidate);
      if (seen.has(key) || !samePostingTitle(entry, candidate)) return false;
      seen.add(key);
      return true;
    });
  }

  function enrich(entries) {
    let enrichedEntries = 0;
    let enrichedFields = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      const candidates = findMatches(entry);
      if (candidates.length === 0) continue;

      const metadataByIdentity = new Map();
      const addMetadata = (candidate) => {
        if (!candidate?.sourceIdentity) return;
        const current = metadataByIdentity.get(candidate.sourceIdentity);
        metadataByIdentity.set(
          candidate.sourceIdentity,
          preferHistoricalCandidate(current, candidate),
        );
      };
      addMetadata(entry);
      for (const history of Array.isArray(entry.sourceIdentityHistory) ? entry.sourceIdentityHistory : []) {
        addMetadata({
          ...entry,
          ...history,
          title: history.title || entry.title,
        });
      }
      for (const candidate of candidates) addMetadata(candidate);

      const metadata = [...metadataByIdentity.values()];
      const primary = metadata
        .filter((candidate) => usableTimestamp(candidate.firstSeenAt))
        .sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt))[0]
        || metadata[0];

      let changed = false;
      if (!entry.sourceIdentity && primary?.sourceIdentity) {
        entry.sourceIdentity = primary.sourceIdentity;
        enrichedFields++;
        changed = true;
      }

      if (primary?.firstSeenAt && usableTimestamp(primary.firstSeenAt)
        && (!usableTimestamp(entry.firstSeenAt)
          || Date.parse(primary.firstSeenAt) < Date.parse(entry.firstSeenAt))) {
        entry.firstSeenAt = primary.firstSeenAt;
        enrichedFields++;
        changed = true;
      }

      const sourceIdentityHistory = metadata
        .filter((candidate) => candidate.sourceIdentity)
        .map((candidate) => ({
          sourceIdentity: candidate.sourceIdentity,
          ...(candidate.firstSeenAt ? { firstSeenAt: candidate.firstSeenAt } : {}),
          ...(candidate.title ? { title: candidate.title } : {}),
        }))
        .sort((a, b) => (a.sourceIdentity < b.sourceIdentity ? -1 : a.sourceIdentity > b.sourceIdentity ? 1 : 0));
      const priorHistorySerialized = JSON.stringify(entry.sourceIdentityHistory || []);
      const nextHistorySerialized = JSON.stringify(sourceIdentityHistory);
      if (sourceIdentityHistory.length > 1 && priorHistorySerialized !== nextHistorySerialized) {
        entry.sourceIdentityHistory = sourceIdentityHistory;
        enrichedFields++;
        changed = true;
      }

      if (changed) enrichedEntries++;
    }
    return { enrichedEntries, enrichedFields };
  }

  /**
   * Repair active crawler entries without letting a shared historical slug
   * replace their current source identity. A crawler can publish two open
   * vacancies with the same title at different locations; the URL identity
   * must win whenever Git history contains that exact URL.
   */
  function enrichActive(entries) {
    let enrichedEntries = 0;
    let enrichedFields = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      const identity = entry.sourceIdentity || buildStableJobIdentity(entry);
      const exactCandidates = identity
        ? (byIdentity.get(identity) || []).filter((candidate) => samePostingTitle(entry, candidate))
        : [];
      const candidates = exactCandidates.length > 0 ? exactCandidates : findMatches(entry);
      if (candidates.length === 0) continue;

      const primary = candidates
        .filter((candidate) => usableTimestamp(candidate.firstSeenAt))
        .sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt))[0];
      let changed = false;

      if (identity && entry.sourceIdentity !== identity) {
        entry.sourceIdentity = identity;
        enrichedFields++;
        changed = true;
      }
      if (primary?.firstSeenAt && usableTimestamp(primary.firstSeenAt)
        && (!usableTimestamp(entry.firstSeenAt)
          || Date.parse(primary.firstSeenAt) < Date.parse(entry.firstSeenAt))) {
        entry.firstSeenAt = primary.firstSeenAt;
        enrichedFields++;
        changed = true;
      }
      if (changed) enrichedEntries++;
    }
    return { enrichedEntries, enrichedFields };
  }

  return { add, enrich, enrichActive };
}

function postingKey(record = {}) {
  const id = String(record?.id ?? '').trim();
  if (id) return `id:${id}`;
  const slug = String(record?.slug ?? '').trim().toLowerCase();
  return slug ? `slug:${slug}` : '';
}

/**
 * Source identities that name MORE THAN ONE posting across the populations
 * being compared.
 *
 * `buildStableJobIdentity` strips the URL fragment and keeps whatever URL the
 * crawler wrote, so a crawler whose only URL is the listing page gives every
 * posting the same identity: Galenica writes `…/it/jobs/#job.id=<n>` for 294
 * roles (all `url:https://jobs.galenica.com/it/jobs`), État de Vaud, Klinik
 * Gut, Klinik Schützen and others write the bare listing URL. Such an identity
 * names a page, not a posting; looking a new vacancy up by it returns some
 * OTHER vacancy's history — measured 2026-10-05: 106 Galenica postings added in
 * a month, all carrying the 2026-04-13 firstSeenAt of the crawler's first run,
 * so no follower of Amavita/Sun Store/Coop Vitality could ever be alerted.
 *
 * Two records with the same identity and the same id/slug are the same posting
 * seen twice (e.g. archived twice) and do not make it ambiguous.
 *
 * @param {...object[]} lists
 * @returns {Set<string>}
 */
export function ambiguousJobIdentities(...lists) {
  const ambiguous = new Set();
  const postingsByIdentity = new Map();
  for (const list of lists) {
    for (const record of Array.isArray(list) ? list : []) {
      if (!record || typeof record !== 'object') continue;
      const posting = postingKey(record);
      if (!posting) continue;
      // Both spellings a caller may look the record up by: the archived
      // `sourceIdentity` and the identity derived from its current URL.
      for (const identity of new Set([record.sourceIdentity, buildStableJobIdentity(record)])) {
        if (!identity) continue;
        const postings = postingsByIdentity.get(identity) || new Set();
        postings.add(posting);
        postingsByIdentity.set(identity, postings);
        if (postings.size > 1) ambiguous.add(identity);
      }
    }
  }
  return ambiguous;
}

/**
 * Carry a job's first-seen history across a temporary disappearance from its
 * crawler slice. The active slice is preferred; the expired slice is the
 * durable fallback used when a source drops and later reintroduces a vacancy.
 *
 * Older expired entries predate sourceIdentity/firstSeenAt. A matching legacy
 * slug still proves that the route was published before, so its fresh
 * firstSeenAt is removed rather than allowing a false immediate alert.
 *
 * An identity shared by several postings ({@link ambiguousJobIdentities}) is
 * never used as a match key: the posting's own `id` and route slugs decide.
 *
 * @param {object[]} jobs Jobs about to be written to the active slice
 * @param {object} options
 * @param {object[]} [options.existingJobs] Prior active slice jobs
 * @param {object[]} [options.archivedJobs] Prior expired-slice entries
 * @returns {{restored: number, suppressed: number, suppressedJobs: Set<object>, ambiguousIdentities: Set<string>}}
 */
export function carryForwardFirstSeenAt(
  jobs,
  { existingJobs = [], archivedJobs = [] } = {},
) {
  const ambiguousIdentities = ambiguousJobIdentities(jobs, existingJobs, archivedJobs);
  const existingByIdentity = new Map();
  const existingBySlug = new Map();
  const existingById = new Map();
  for (const job of Array.isArray(existingJobs) ? existingJobs : []) {
    addExistingHistory(job, existingByIdentity, existingBySlug);
    const id = String(job?.id ?? '').trim();
    if (id && usableTimestamp(job?.firstSeenAt)) indexEntry(existingById, id, job);
  }

  const archivedByIdentity = new Map();
  const archivedBySlug = new Map();
  for (const entry of Array.isArray(archivedJobs) ? archivedJobs : []) {
    addRecordToIndexes(entry, archivedByIdentity, archivedBySlug);
  }

  let restored = 0;
  let suppressed = 0;
  const suppressedJobs = new Set();

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    const stableIdentity = buildStableJobIdentity(job);
    const identity = ambiguousIdentities.has(stableIdentity) ? '' : stableIdentity;
    const slugs = [...routeSlugs(job)].map((slug) => `slug:${slug}`);
    const id = String(job.id ?? '').trim();

    const active = (identity ? findMatchingEntry(existingByIdentity.get(identity), job) : null)
      || (id ? findMatchingEntry(existingById.get(id), job) : null)
      || slugs.map((key) => findMatchingEntry(existingBySlug.get(key), job)).find(Boolean);
    if (active) {
      const before = job.firstSeenAt;
      job.firstSeenAt = earlierTimestamp(before, active.firstSeenAt);
      if (job.firstSeenAt !== before) restored++;
      continue;
    }

    const archived = (identity ? findMatchingEntry(archivedByIdentity.get(identity), job) : null)
      || slugs.map((key) => findMatchingEntry(archivedBySlug.get(key), job)).find(Boolean);
    if (!archived) continue;

    if (usableTimestamp(archived.firstSeenAt)) {
      const before = job.firstSeenAt;
      job.firstSeenAt = earlierTimestamp(before, archived.firstSeenAt);
      if (job.firstSeenAt !== before) restored++;
    } else {
      // There is no trustworthy historical timestamp in legacy archives. An
      // absent firstSeenAt is fail-closed for the immediate sender and avoids
      // inventing a “new” date for an already published route.
      delete job.firstSeenAt;
      suppressedJobs.add(job);
      suppressed++;
    }
  }

  return { restored, suppressed, suppressedJobs, ambiguousIdentities };
}

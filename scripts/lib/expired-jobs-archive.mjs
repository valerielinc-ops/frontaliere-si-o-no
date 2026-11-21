/**
 * Per-crawler expired-jobs archival.
 *
 * Dedicated crawlers refetch the upstream ATS each run and overwrite their
 * `data/jobs/by-crawler/<key>.json` slice with the current vacancies. When a
 * job disappears from upstream (vacancy filled, listing removed) it is
 * dropped from the slice silently — `mergePreserveLocaleData` iterates only
 * the fresh batch, so any prior entry not present in the new fetch is gone.
 *
 * Without archival, indexed-by-Google detail URLs (and their previousSlug
 * bridges) 404 on the next deploy instead of rendering JobExpiredView. This
 * module captures those drops into `data/jobs/expired/by-crawler/<key>.json`
 * so the build plugin can emit the soft-landing page.
 *
 * Shape of an expired entry mirrors `cleanup-jobs.mjs:buildExpiredEntry`
 * so both code paths produce the same on-disk format.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { compareExpiredAt } from './compare-expired-at.mjs';
import {
  addPreviousSlugForLocale,
  appendSlugDisambiguator,
  DEFAULT_PREV_SLUG_CAP,
  decodeUnicodeEscapeLeaks,
  getPreviousSlugsForLocale,
  isLegacyRouteCapRefusal,
  LOCALES,
  promotePreviousSlugToLegacy,
} from './dedicated-crawler-common.mjs';
import { addPreviousSlugRoutesKeepAll, replaceSlugRouteEverywhere } from './slug-history-journal.mjs';
import {
  archiveRecordNamesPosting,
  archiveRecordSourceIdentities,
  buildStableJobIdentity,
  stablePostingIdentities,
} from './job-identity.mjs';
import { isHeldFromPublication } from './translation-publication-hold.mjs';
import { assertByteSizeCeiling } from './assert-file-size-ceiling.mjs';
import { readExpiredSliceRows, readExpiredSliceShards, writeExpiredSliceRows } from './expired-slice-store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EXPIRED_SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');

/**
 * Build an expired-job archive entry from a job object. Preserves the fields
 * the build plugin needs to render an enriched JobExpiredView under any
 * locale prefix (slugByLocale, descriptionByLocale, previousSlugs, salary +
 * address). Keeps its shape aligned with `scripts/cleanup-jobs.mjs:buildExpiredEntry`.
 *
 * @param {object} job
 * @returns {object} expired entry
 */
export function buildExpiredEntry(job) {
  const sourceIdentity = job?.sourceIdentity || (job?.url ? buildStableJobIdentity(job) : '');
  const entry = {
    id: job?.id || job?.externalId || job?.jobId || undefined,
    slug: job.slug,
    title: job.title || '',
    titleByLocale: { ...(job.titleByLocale || {}) },
    company: job.company || '',
    companyKey: job.companyKey || '',
    location: job.location || '',
    canton: job.canton || undefined,
    addressLocality: job.addressLocality || '',
    descriptionByLocale: job.descriptionByLocale || {},
    slugByLocale: job.slugByLocale || {},
    sector: job.sector || '',
    expiredAt: new Date().toISOString(),
    previousSlugs:
      Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0
        ? [...job.previousSlugs]
        : undefined,
    previousSlugsByLocale:
      job.previousSlugsByLocale &&
      typeof job.previousSlugsByLocale === 'object' &&
      Object.keys(job.previousSlugsByLocale).length > 0
        ? JSON.parse(JSON.stringify(job.previousSlugsByLocale))
        : undefined,
    postalCode: job.postalCode || '',
    streetAddress: job.streetAddress || '',
    salaryMin: job.salaryMin || null,
    salaryMax: job.salaryMax || null,
    salaryCurrency: job.salaryCurrency || 'CHF',
    salaryPeriod: job.salaryPeriod || 'YEAR',
    dedupArchive: job.dedupArchive === true ? true : undefined,
    sourceIdentity: sourceIdentity || undefined,
    firstSeenAt: job.firstSeenAt || undefined,
    sourceIdentityHistory:
      Array.isArray(job.sourceIdentityHistory) && job.sourceIdentityHistory.length > 0
        ? JSON.parse(JSON.stringify(job.sourceIdentityHistory))
        : undefined,
  };
  normalizeExpiredEntryTitles(entry);
  if (!entry.postalCode) delete entry.postalCode;
  if (!entry.streetAddress) delete entry.streetAddress;
  if (!entry.salaryMin) delete entry.salaryMin;
  if (!entry.salaryMax) delete entry.salaryMax;
  if (!entry.canton) delete entry.canton;
  if (!entry.id) delete entry.id;
  if (entry.dedupArchive !== true) delete entry.dedupArchive;
  if (!entry.sourceIdentity) delete entry.sourceIdentity;
  if (!entry.firstSeenAt) delete entry.firstSeenAt;
  if (!entry.sourceIdentityHistory) delete entry.sourceIdentityHistory;
  return entry;
}

/** An `expiredAt` that `Date.parse` can actually order. */
export function isParsableExpiredAt(value) {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));
}

/**
 * Repair title fields that were persisted with a literal JSON unicode escape.
 *
 * Refline's old title extractor could read an escaped `<h1>` from JSON-LD and
 * write values such as `Interpr\\u00e8te` into a job. Active crawler hardening
 * already repairs this class, but expired entries do not get crawled again, so
 * the archive writers need the same last-resort boundary. Descriptions are
 * deliberately excluded: unlike titles, they may legitimately quote escape
 * syntax in developer-facing job text.
 *
 * @param {object} entry
 * @returns {boolean} whether a title field changed
 */
export function normalizeExpiredEntryTitles(entry) {
  if (!entry || typeof entry !== 'object') return false;
  let changed = false;
  const decode = (value) => {
    if (typeof value !== 'string') return value;
    const decoded = decodeUnicodeEscapeLeaks(value);
    if (decoded !== value) changed = true;
    return decoded;
  };

  if (typeof entry.title === 'string') entry.title = decode(entry.title);
  if (entry.titleByLocale && typeof entry.titleByLocale === 'object' && !Array.isArray(entry.titleByLocale)) {
    for (const [locale, value] of Object.entries(entry.titleByLocale)) {
      entry.titleByLocale[locale] = decode(value);
    }
  }
  return changed;
}

const DETERMINISTIC_EXPIRED_AT_EPOCH = Date.parse('2025-01-01T00:00:00.000Z');
const DETERMINISTIC_EXPIRED_AT_SPAN = 365 * 24 * 60 * 60 * 1000;

/**
 * Derive a repeatable fallback timestamp for a legacy entry with no usable
 * expiry date. Stable identity fields are preferred; the hash only spreads
 * otherwise indistinguishable records across one fixed historical year.
 */
export function deterministicExpiredAt(entry = {}) {
  const identity = [entry.id, entry.url, entry.slug, entry.firstSeenAt]
    .find((value) => value != null && String(value).trim() !== '');
  const seed = identity != null
    ? String(identity)
    : JSON.stringify({
        companyKey: entry.companyKey || '',
        title: entry.title || '',
        location: entry.location || '',
      });
  const hash = createHash('sha1').update(seed).digest('hex').slice(0, 12);
  const offset = Number.parseInt(hash, 16) % DETERMINISTIC_EXPIRED_AT_SPAN;
  return new Date(DETERMINISTIC_EXPIRED_AT_EPOCH + offset).toISOString();
}

/**
 * Give every entry read back from disk an `expiredAt` the downstream sort can
 * order and clean title fields before it reaches one of the two
 * `slice(0, EXPIRED_JOBS_CAP)` cuts (`assemble-jobs-dataset.mjs`,
 * `cleanup-jobs.mjs`).
 *
 * `buildExpiredEntry` always stamps a fresh ISO timestamp, so an unparseable
 * value can only arrive from an archive already on disk (hand-edit, legacy
 * format, truncated write). `compareExpiredAt` sends such a value to the tail
 * BY CONSTRUCTION — the safe direction for a comparator, but the archive is
 * then cut at 5000, so an entry that sat inside the cap in the input gets
 * pushed out of it and the soft landing for a still-indexed URL 404s. The
 * comparator is not the defect: the defect is that the value reaches it at
 * all, so it is repaired at the ingress instead.
 *
 * The repair stamps a deterministic timestamp derived from the entry identity
 * (or an explicitly supplied `now` for a controlled backfill). That keeps the
 * relative order stable when a deploy pipeline reads the same legacy input
 * again, including when the entry sits near the aggregate cap.
 *
 * Mutates in place — every caller hands over entries it just parsed from JSON.
 *
 * @param {object[]} entries
 * @param {object} [opts]
 * @param {string} [opts.now] - Explicit timestamp for a controlled backfill;
 *   production callers use the deterministic identity-derived fallback.
 * @param {string} [opts.source] - Label for the log line
 * @returns {number} repaired count
 */
export function normalizeExpiredAtEntries(entries, opts = {}) {
  if (!Array.isArray(entries)) return 0;
  const explicitNow = isParsableExpiredAt(opts.now) ? opts.now : '';
  const source = opts.source || 'expired-archive-normalize';
  let repaired = 0;
  const stamped = new Set();
  let timestampRepairs = 0;
  let titleRepairs = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const titlesChanged = normalizeExpiredEntryTitles(entry);
    if (titlesChanged) titleRepairs += 1;
    let changed = titlesChanged;
    if (!isParsableExpiredAt(entry.expiredAt)) {
      entry.expiredAt = explicitNow || deterministicExpiredAt(entry);
      stamped.add(entry.expiredAt);
      timestampRepairs += 1;
      changed = true;
    }
    if (changed) repaired += 1;
  }
  if (timestampRepairs > 0) {
    console.log(`  🩹 ${source}: ${timestampRepairs} expired entries had no parsable expiredAt → stamped ${[...stamped].join(', ')}`);
  }
  if (titleRepairs > 0) {
    console.log(`  🩹 ${source}: ${titleRepairs} expired entries had literal unicode escapes in title fields → decoded`);
  }
  return repaired;
}

function hasExplicitlyDifferentSourceIdentity(expiredJob, activeJob) {
  const expiredIdentities = archiveRecordSourceIdentities(expiredJob);
  const activeIdentities = stablePostingIdentities(activeJob);
  if (expiredIdentities.size === 0 || activeIdentities.size === 0) return false;
  return ![...expiredIdentities].some((identity) => activeIdentities.has(identity));
}

function explicitArchiveSourceIdentities(record = {}) {
  return archiveRecordSourceIdentities(record);
}

function collisionRouteSuffix(entry, route, attempt) {
  const identities = [...archiveRecordSourceIdentities(entry)].sort();
  const source = identities[0] || String(entry.sourceIdentity || '').trim();
  return createHash('sha1')
    .update(`expired-route-owner\0${source}\0${route}\0${attempt}`)
    .digest('hex')
    .slice(0, 8);
}

/** Upper bound for the alias search; far above any real chain, it only stops a runaway loop. */
const MAX_COLLISION_ATTEMPTS = 10_000;

/**
 * Count how many records (active or expired) hold each locale-qualified route.
 * A count, not a set: an alias can legitimately be held by more than one record
 * (histories are transferred between records), and "is it MINE alone?" needs to
 * tell those apart.
 */
function addRouteHolders(holders, keys) {
  for (const key of keys) holders.set(key, (holders.get(key) || 0) + 1);
}

/**
 * Pick the alias a colliding record should move `route` to, in `locale`.
 *
 * Deterministic: the candidates are `collisionRouteSuffix(entry, route, 0, 1, 2…)`.
 * The first one NO OTHER record holds wins. A candidate the record already owns
 * is reused, not skipped: that is what makes the repair idempotent. The old loop
 * treated the record's own alias as "reserved", discarded it and coined the next
 * attempt, so every time the route re-entered the record (a fresh payload, a
 * history merge) it got one more alias — 197 aliases of one stem inside a single
 * Denner record, 73% of the expired sitemap slugs ending in 8 hex digits.
 *
 * @returns {{ replacement: string, key: string, reused: boolean }}
 */
function chooseCollisionReplacement(entry, route, locale, routeHolders, ownKeys) {
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const replacement = appendSlugDisambiguator(route, collisionRouteSuffix(entry, route, attempt));
    const key = `${locale}:${replacement}`;
    const own = ownKeys.has(key);
    const heldByOthers = (routeHolders.get(key) || 0) - (own ? 1 : 0) > 0;
    if (heldByOthers) continue;
    return { replacement, key, reused: own };
  }
  throw new Error(`expired route collision repair found no free alias for ${locale}:${route} after ${MAX_COLLISION_ATTEMPTS} attempts`);
}

/** After a record was repaired, bring the holder counts in line with the routes it serves now. */
function syncRouteHolders(holders, before, after) {
  for (const key of before) {
    if (after.has(key)) continue;
    const count = holders.get(key) || 0;
    if (count <= 1) holders.delete(key);
    else holders.set(key, count - 1);
  }
  for (const key of after) if (!before.has(key)) holders.set(key, (holders.get(key) || 0) + 1);
}

/**
 * One repair can expose another: moving a flat previous slug out of one locale
 * copies it into the others, where it may collide too. Re-check the record until
 * it is clean (bounded), so a single call leaves a fixed point and a second call
 * has nothing left to do.
 */
const MAX_REPAIR_ROUNDS = 8;

/**
 * Keep an expired archive record from claiming a route that belongs to a
 * different active posting.
 *
 * A title/company/location slug is not a posting identity. The active and
 * expired records can therefore legitimately share that derived slug while
 * naming different source URLs. Ghost reconciliation must retain that source
 * identity distinction, but the route index still needs one owner. In that
 * narrow, source-proven case, deterministically move every occurrence of the
 * archived route (current and historical, including locale maps) to a unique
 * archive route. Unknown or identity-less records are left untouched so this
 * repair never guesses which posting owns a route.
 *
 * Mutates `expiredJobs` in place and is idempotent: the alias for `(route, attempt)`
 * is deterministic and a record that already owns it reuses it, so a second pass
 * over the same input changes nothing (`changed === 0`) and never mints another
 * alias, even if the route re-entered the record in between.
 *
 * @param {object[]} expiredJobs
 * @param {object[]} activeJobs
 * @returns {{ entries: object[], changed: number, repairedRoutes: number, details: string[] }}
 */
export function repairExpiredRoutesAgainstActive(expiredJobs, activeJobs) {
  if (!Array.isArray(expiredJobs) || !Array.isArray(activeJobs) || activeJobs.length === 0) {
    return { entries: Array.isArray(expiredJobs) ? expiredJobs : [], changed: 0, repairedRoutes: 0, details: [] };
  }

  const activeRouteOwners = new Map();
  for (const activeJob of activeJobs) {
    for (const routeKey of localeRouteKeys(activeJob)) {
      const owners = activeRouteOwners.get(routeKey) || [];
      if (!owners.includes(activeJob)) owners.push(activeJob);
      activeRouteOwners.set(routeKey, owners);
    }
  }

  const routeHolders = new Map();
  for (const [routeKey, owners] of activeRouteOwners) routeHolders.set(routeKey, owners.length);
  for (const expiredJob of expiredJobs) addRouteHolders(routeHolders, localeRouteKeys(expiredJob));

  let changed = 0;
  let repairedRoutes = 0;
  const details = [];
  for (const expiredJob of expiredJobs) {
    if (!expiredJob || typeof expiredJob !== 'object') continue;
    const initialKeys = localeRouteKeys(expiredJob);
    for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
      const ownKeys = localeRouteKeys(expiredJob);
      const conflictingRouteKeys = [...ownKeys].filter((routeKey) => {
        const owners = activeRouteOwners.get(routeKey);
        if (!owners || owners.length === 0) return false;
        // If any active owner is provably the same posting, ghost reconciliation
        // owns this route and must be allowed to remove/merge it normally.
        if (owners.some((owner) => archiveRecordNamesPosting(expiredJob, owner))) return false;
        // A collision is repairable only when every active owner is explicitly
        // different. Ambiguous source evidence must not trigger a rewrite.
        return owners.every((owner) => hasExplicitlyDifferentSourceIdentity(expiredJob, owner));
      });
      if (conflictingRouteKeys.length === 0) break;

      let progressed = false;
      for (const routeKey of conflictingRouteKeys) {
        const locale = localeFromRouteKey(routeKey);
        const route = rawRouteFromLocaleKey(routeKey);
        const { replacement } = chooseCollisionReplacement(
          expiredJob, route, locale, routeHolders, ownKeys,
        );

        if (!replaceSlugRouteEverywhere(expiredJob, route, replacement, {
          source: 'expired-jobs-archive.repairExpiredRoutesAgainstActive',
          reason: 'route collides with a distinct active posting',
          locale,
          cap: DEFAULT_PREV_SLUG_CAP,
        })) continue;
        progressed = true;
        changed += 1;
        repairedRoutes += 1;
        if (details.length < 20) details.push(`${routeKey} → ${locale}:${replacement}`);
      }
      if (!progressed) break;
    }
    syncRouteHolders(routeHolders, initialKeys, localeRouteKeys(expiredJob));
  }

  return { entries: expiredJobs, changed, repairedRoutes, details };
}

function hasExplicitlyDifferentArchiveIdentity(left, right) {
  const leftIdentities = explicitArchiveSourceIdentities(left);
  const rightIdentities = explicitArchiveSourceIdentities(right);
  if (leftIdentities.size === 0 || rightIdentities.size === 0) return false;
  return [...leftIdentities].every((identity) => !rightIdentities.has(identity));
}

function explicitArchiveDeclaredSourceIdentities(record = {}) {
  const sourceIdentityHistory = Array.isArray(record.sourceIdentityHistory)
    ? record.sourceIdentityHistory.map((entry) => ({ sourceIdentity: entry?.sourceIdentity }))
    : [];
  return archiveRecordSourceIdentities({
    sourceIdentity: record.sourceIdentity,
    sourceIdentityHistory,
  });
}

function hasExplicitlyDifferentDeclaredSourceIdentity(left, right) {
  const leftIdentities = explicitArchiveDeclaredSourceIdentities(left);
  const rightIdentities = explicitArchiveDeclaredSourceIdentities(right);
  if (leftIdentities.size === 0 || rightIdentities.size === 0) return false;
  return [...leftIdentities].every((identity) => !rightIdentities.has(identity));
}

function hasExplicitlySharedDeclaredSourceIdentity(left, right) {
  const leftIdentities = explicitArchiveDeclaredSourceIdentities(left);
  const rightIdentities = explicitArchiveDeclaredSourceIdentities(right);
  if (leftIdentities.size === 0 || rightIdentities.size === 0) return false;
  return [...leftIdentities].some((identity) => rightIdentities.has(identity));
}

function hasExplicitlySharedArchiveIdentity(left, right) {
  const leftIdentities = explicitArchiveSourceIdentities(left);
  const rightIdentities = explicitArchiveSourceIdentities(right);
  if (leftIdentities.size === 0 || rightIdentities.size === 0) return false;
  return [...leftIdentities].some((identity) => rightIdentities.has(identity));
}

function localeFromRouteKey(routeKey) {
  const separator = String(routeKey).indexOf(':');
  return separator > 0 ? String(routeKey).slice(0, separator) : 'it';
}

function rawRouteFromLocaleKey(routeKey) {
  const separator = String(routeKey).indexOf(':');
  return separator >= 0 ? String(routeKey).slice(separator + 1) : String(routeKey);
}

/**
 * Give a distinct expired posting its own route before route-collapse can
 * mistake it for a same-posting history merge.
 *
 * A current/history slug is derived data, not a posting identity. When two
 * entries in the same company archive have a locale route in common, merging
 * them is safe only when the source identities are not provably different.
 * The identity-less and ambiguous cases remain untouched; a guessed rewrite
 * would be worse than a visible duplicate that a later reconciliation can
 * inspect. A proven distinct older entry keeps all of its route-bearing fields,
 * but the shared raw slug is moved everywhere through the journal primitive so
 * no locale/history mirror retains the old owner.
 *
 * Mutates `entries` in place and is idempotent (same reuse rule as
 * `repairExpiredRoutesAgainstActive`: the deterministic alias a record already
 * owns is reused, never replaced by a new one).
 *
 * @param {object[]} entries
 * @param {{source?: string, repairUnprovenCollisions?: boolean, sourceIdentityOnly?: boolean}} [options]
 * `repairUnprovenCollisions` is reserved for an ownership reconciliation
 * boundary that has already refused a lossy history merge. It keeps the
 * records separate and repairs only the duplicate route; the default remains
 * fail-closed for ambiguous archive identity in the general writers.
 * `sourceIdentityOnly` is for archive ownership reconciliation: raw `id` and
 * `url` fields can differ between crawler slices that carry the same historic
 * alias, so only persisted `sourceIdentity` provenance can preempt that merge.
 * @returns {{entries: object[], changed: number, repairedRoutes: number, details: string[]}}
 */
export function repairExpiredRoutesWithinArchive(
  entries,
  {
    source = 'expired-jobs-archive.repairExpiredRoutesWithinArchive',
    repairUnprovenCollisions = false,
    sourceIdentityOnly = false,
  } = {},
) {
  if (!Array.isArray(entries) || entries.length < 2) {
    return {
      entries: Array.isArray(entries) ? entries : [],
      changed: 0,
      repairedRoutes: 0,
      details: [],
    };
  }

  const ordered = [...entries].sort(compareArchiveEntries);
  const owners = new Map();
  const routeHolders = new Map();
  for (const entry of ordered) {
    if (entry && typeof entry === 'object') addRouteHolders(routeHolders, localeRouteKeys(entry));
  }
  let changed = 0;
  let repairedRoutes = 0;
  const details = [];

  for (const entry of ordered) {
    if (!entry || typeof entry !== 'object' || !entry.companyKey) continue;

    const initialKeys = localeRouteKeys(entry);
    for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
      const ownKeys = localeRouteKeys(entry);
      const conflictingRouteKeys = [];
      for (const routeKey of ownKeys) {
        const ownerKey = `${entry.companyKey}::${routeKey}`;
        const routeOwners = owners.get(ownerKey) || [];
        if (routeOwners.length === 0) continue;
        const explicitlyDifferent = sourceIdentityOnly
          ? hasExplicitlyDifferentDeclaredSourceIdentity
          : hasExplicitlyDifferentArchiveIdentity;
        const hasProvenSharedIdentity = routeOwners.some((owner) => (
          sourceIdentityOnly
            ? hasExplicitlySharedDeclaredSourceIdentity(entry, owner)
            : hasExplicitlySharedArchiveIdentity(entry, owner)
        ));
        if ((!hasProvenSharedIdentity && repairUnprovenCollisions)
          || routeOwners.every((owner) => explicitlyDifferent(entry, owner))) {
          conflictingRouteKeys.push(routeKey);
        }
      }
      if (conflictingRouteKeys.length === 0) break;

      let progressed = false;
      for (const routeKey of conflictingRouteKeys) {
        const locale = localeFromRouteKey(routeKey);
        const route = rawRouteFromLocaleKey(routeKey);
        const { replacement } = chooseCollisionReplacement(
          entry, route, locale, routeHolders, ownKeys,
        );

        if (!replaceSlugRouteEverywhere(entry, route, replacement, {
          source,
          reason: 'route collides with a distinct expired posting',
          locale,
          cap: DEFAULT_PREV_SLUG_CAP,
        })) continue;

        progressed = true;
        changed += 1;
        repairedRoutes += 1;
        if (details.length < 20) details.push(`${routeKey} → ${locale}:${replacement}`);
      }
      if (!progressed) break;
    }
    syncRouteHolders(routeHolders, initialKeys, localeRouteKeys(entry));

    for (const routeKey of localeRouteKeys(entry)) {
      const ownerKey = `${entry.companyKey}::${routeKey}`;
      const routeOwners = owners.get(ownerKey) || [];
      if (!routeOwners.includes(entry)) routeOwners.push(entry);
      owners.set(ownerKey, routeOwners);
    }
  }

  return { entries, changed, repairedRoutes, details };
}

/**
 * Preserve first-seen metadata when two archive payloads collapse onto one
 * route. Route history can represent multiple legitimate source postings, so
 * a single `sourceIdentity` is not enough after a dedup merge.
 *
 * @returns {boolean} whether the survivor changed
 */
export function mergeSourceIdentityHistory(survivor, removed) {
  if (!survivor || typeof survivor !== 'object' || !removed || typeof removed !== 'object') {
    return false;
  }

  const byIdentity = new Map();
  const add = (identity, firstSeenAt, title) => {
    if (!identity) return;
    const incoming = {
      sourceIdentity: identity,
      ...(firstSeenAt ? { firstSeenAt } : {}),
      ...(title ? { title } : {}),
    };
    const current = byIdentity.get(identity);
    if (!current) {
      byIdentity.set(identity, incoming);
      return;
    }
    const currentTime = Date.parse(current.firstSeenAt || '');
    const incomingTime = Date.parse(incoming.firstSeenAt || '');
    if ((!Number.isFinite(currentTime) && Number.isFinite(incomingTime))
      || (Number.isFinite(currentTime) && Number.isFinite(incomingTime) && incomingTime < currentTime)) {
      byIdentity.set(identity, { ...current, ...incoming });
    }
  };
  const addRecord = (record) => {
    add(record.sourceIdentity, record.firstSeenAt, record.title);
    for (const history of Array.isArray(record.sourceIdentityHistory) ? record.sourceIdentityHistory : []) {
      add(history?.sourceIdentity, history?.firstSeenAt || record.firstSeenAt, history?.title || record.title);
    }
  };
  addRecord(survivor);
  addRecord(removed);

  const history = [...byIdentity.values()].sort((a, b) => (
    a.sourceIdentity < b.sourceIdentity ? -1 : a.sourceIdentity > b.sourceIdentity ? 1 : 0
  ));
  const before = JSON.stringify({
    sourceIdentity: survivor.sourceIdentity,
    firstSeenAt: survivor.firstSeenAt,
    sourceIdentityHistory: survivor.sourceIdentityHistory,
  });

  if (!survivor.sourceIdentity && history[0]) survivor.sourceIdentity = history[0].sourceIdentity;
  if (!survivor.firstSeenAt && history[0]?.firstSeenAt) survivor.firstSeenAt = history[0].firstSeenAt;
  if (history.length > 1) survivor.sourceIdentityHistory = history;
  else delete survivor.sourceIdentityHistory;

  const after = JSON.stringify({
    sourceIdentity: survivor.sourceIdentity,
    firstSeenAt: survivor.firstSeenAt,
    sourceIdentityHistory: survivor.sourceIdentityHistory,
  });
  return before !== after;
}

/**
 * Preserve route evidence when a historical archive payload is merged into a
 * newer record for the same canonical slug. The newer payload remains the
 * content winner, but its locale map/history must not erase routes that were
 * actually served by the older payload. Canton is part of the public route;
 * fill it only when the newer record has no value, never overwrite a newer
 * explicit context.
 *
 * @returns {boolean} whether route evidence or context changed
 */
export function mergeExpiredRouteEvidence(survivor, historical, source = 'expired-route-evidence') {
  if (!survivor || typeof survivor !== 'object' || !historical || typeof historical !== 'object') {
    return false;
  }
  const before = JSON.stringify({
    canton: survivor.canton,
    location: survivor.location,
    slugByLocale: survivor.slugByLocale,
    previousSlugs: survivor.previousSlugs,
    previousSlugsByLocale: survivor.previousSlugsByLocale,
  });
  if (!survivor.canton && historical.canton) survivor.canton = historical.canton;
  if (!survivor.location && historical.location) survivor.location = historical.location;
  transferSlugHistory(survivor, historical, source);
  const after = JSON.stringify({
    canton: survivor.canton,
    location: survivor.location,
    slugByLocale: survivor.slugByLocale,
    previousSlugs: survivor.previousSlugs,
    previousSlugsByLocale: survivor.previousSlugsByLocale,
  });
  return before !== after;
}

/**
 * Archive removed jobs to a per-crawler expired slice file.
 *
 * Merges with any existing entries by `slug`, keeping the most-recently
 * expired entry per slug. Skips jobs without a slug (no static page to land
 * on). An empty `removedJobs` list still reads the existing file so
 * title/timestamp repairs are persisted during a clean housekeeping run.
 * Returns the number of newly-added entries; zero means no new slug was added.
 *
 * @param {object[]} removedJobs - Full job objects (NOT `{ id }` refs)
 * @param {string} crawlerKey
 * @param {object} [opts]
 * @param {string} [opts.dir] - Override directory (default: data/jobs/expired/by-crawler)
 * @param {object[]} [opts.activeJobs] - Current active generation. When provided,
 *   expired routes that belong to a distinct source posting are disambiguated
 *   before the slice is persisted (including slice-only crawler runs).
 * @returns {number} added count
 */
/**
 * Refuse an expired slice that would cross the push-safety ceiling
 * (scripts/lib/assert-file-size-ceiling.mjs, 90 MB for these slices) BEFORE it
 * is written: a slice over GitHub's 100 MB limit otherwise fails only as a
 * rejected push, after the crawler run that grew it. Measured on the bytes
 * writeJsonAtomic would write for this array.
 *
 * @param {string} slicePath
 * @param {object[]} entries
 */
export function assertExpiredSliceSize(slicePath, entries) {
  let bytes;
  try {
    bytes = Buffer.byteLength(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  } catch (error) {
    // Past V8's string limit the slice is far over any ceiling.
    if (error instanceof RangeError) bytes = Number.MAX_SAFE_INTEGER;
    else throw error;
  }
  assertByteSizeCeiling(slicePath, bytes);
}

/**
 * Read a crawler's expired archive — the monolith and every
 * `<key>.shard-NNN.json` (scripts/lib/expired-slice-store.mjs) — read-only;
 * missing or corrupt → `[]`.
 *
 * @param {string} crawlerKey
 * @param {{ dir?: string }} [opts]
 * @returns {object[]}
 */
export function readExpiredSlice(crawlerKey, opts = {}) {
  if (!crawlerKey) return [];
  const dir = opts.dir || DEFAULT_EXPIRED_SLICES_DIR;
  try {
    return readExpiredSliceRows(crawlerKey, { dir });
  } catch {
    return [];
  }
}

/** How many deterministic aliases of a route are probed (the repair picks the lowest free attempt). */
const MAX_ALIAS_PROBE = 256;

/** Whether `record` already holds a deterministic collision alias of `routeKey`. */
function holdsDeterministicAlias(record, routeKey, heldKeys = localeRouteKeys(record)) {
  const locale = localeFromRouteKey(routeKey);
  const route = rawRouteFromLocaleKey(routeKey);
  for (let attempt = 0; attempt < MAX_ALIAS_PROBE; attempt += 1) {
    const alias = appendSlugDisambiguator(route, collisionRouteSuffix(record, route, attempt));
    if (heldKeys.has(`${locale}:${alias}`)) return true;
  }
  return false;
}

/**
 * Merge routes an existing record no longer serves into ITS history through the journal
 * primitive `addPreviousSlugRoutesKeepAll`, which never trims: `transferSlugHistory` goes
 * through the 20-entry buckets and would evict served routes from a record that is already
 * far over the cap (one Denner record holds 1 029 entries in `it`). Only the given routes
 * travel: a route the repair already moved to an alias must not come back as a stem.
 *
 * @returns {boolean} whether the routes were merged
 */
function mergeUnservedRoutesIntoRecord(record, routeKeys) {
  const byLocale = {};
  for (const routeKey of routeKeys) {
    const locale = localeFromRouteKey(routeKey);
    (byLocale[locale] ||= []).push(rawRouteFromLocaleKey(routeKey));
  }
  addPreviousSlugRoutesKeepAll(record, byLocale, {
    source: 'expired-jobs-archive.archiveRemovedJobsToSlice/same-identity',
    cap: DEFAULT_PREV_SLUG_CAP,
  });
  return true;
}

export function archiveRemovedJobsToSlice(removedJobs, crawlerKey, opts = {}) {
  if (!crawlerKey) return 0;
  if (!Array.isArray(removedJobs)) return 0;

  const dir = opts.dir || DEFAULT_EXPIRED_SLICES_DIR;
  fs.mkdirSync(dir, { recursive: true });

  // Every file of the crawler's archive (monolith + shards). Fails closed on
  // an unreadable file: starting from `[]` would rewrite it with only this
  // run's rows.
  const shards = readExpiredSliceShards(crawlerKey, { dir });
  const existing = shards.flatMap((shard) => shard.rows);
  const repaired = normalizeExpiredAtEntries(existing, {
    source: `archive-removed-jobs-to-slice/${crawlerKey}`,
  });

  const bySlug = new Map();
  for (const ej of existing) {
    if (ej?.slug) bySlug.set(ej.slug, ej);
  }
  const sizeBefore = bySlug.size;
  // The archive is keyed by slug, but a collision repair MOVES a record's slug to a
  // deterministic alias. Re-archiving the same removed job then missed `bySlug`,
  // minted a second record carrying the job's original (colliding) history, and the
  // next repair coined fresh aliases for it: the loop behind the linear growth of
  // the expired pages (#14030 added the alias repair, 20 Oct 2026). Index the
  // archive by source identity too, so the same posting is recognised. This must NOT
  // depend on `opts.activeJobs`: assemble-jobs-dataset.mjs (every assembly) and the
  // ~25 update-*.mjs crawlers call this writer without it.
  //
  // The index lives for the whole call: every record that enters `bySlug` (new or
  // replacing) is indexed as it enters and a replaced record is un-indexed, so two
  // removed jobs of the SAME call with one source identity and different slugs also end
  // up in one record (the second one's routes are merged into the first).
  const recordsBySourceIdentity = new Map(); // identity -> Set<record>, insertion order
  const sliceRouteHolders = new Map();
  const indexRecord = (record) => {
    for (const identity of archiveRecordSourceIdentities(record)) {
      let records = recordsBySourceIdentity.get(identity);
      if (!records) recordsBySourceIdentity.set(identity, records = new Set());
      records.add(record);
    }
    addRouteHolders(sliceRouteHolders, localeRouteKeys(record));
  };
  const unindexRecord = (record) => {
    for (const identity of archiveRecordSourceIdentities(record)) {
      const records = recordsBySourceIdentity.get(identity);
      if (!records) continue;
      records.delete(record);
      if (records.size === 0) recordsBySourceIdentity.delete(identity);
    }
    syncRouteHolders(sliceRouteHolders, localeRouteKeys(record), new Set());
  };
  const recordOfSourceIdentity = (identity) => {
    const records = identity ? recordsBySourceIdentity.get(identity) : undefined;
    return records ? records.values().next().value : undefined;
  };
  for (const ej of existing) indexRecord(ej);
  const activeRouteKeys = new Set();
  for (const activeJob of Array.isArray(opts.activeJobs) ? opts.activeJobs : []) {
    for (const routeKey of localeRouteKeys(activeJob)) activeRouteKeys.add(routeKey);
  }

  let added = 0;
  let metadataChanged = false;
  const firstSeenMetadata = (entry) => JSON.stringify({
    sourceIdentity: entry?.sourceIdentity,
    firstSeenAt: entry?.firstSeenAt,
    sourceIdentityHistory: entry?.sourceIdentityHistory,
  });
  for (const job of removedJobs) {
    if (!job?.slug) continue;
    // A job held out of publication for translation (agency admission
    // threshold) never had a public URL: archiving it would mint an expired
    // soft-landing page for a route nobody was ever served.
    if (isHeldFromPublication(job)) continue;
    const entry = buildExpiredEntry(job);
    const prev = bySlug.get(entry.slug);
    if (!prev) {
      // Same posting already archived under another slug (its slug was moved to an
      // alias by the collision repair): NEVER a second record. The existing record
      // stays the owner of the posting; routes it no longer serves are merged into
      // its history below, so no URL stops resolving. A route counts as served when
      //   - the record holds it, or
      //   - the record holds one of its deterministic aliases (the repair already
      //     moved it, and the idempotent repair will move it there again), or
      //   - an active posting (when the caller knows them) or ANOTHER record of the
      //     slice holds it.
      const sameRecord = recordOfSourceIdentity(entry.sourceIdentity);
      if (sameRecord) {
        const held = localeRouteKeys(sameRecord);
        const unserved = [...localeRouteKeys(entry)].filter((routeKey) => {
          if (held.has(routeKey) || activeRouteKeys.has(routeKey)) return false;
          if ((sliceRouteHolders.get(routeKey) || 0) > 0) return false; // held by another record (not this one: `held` is checked above)
          return !holdsDeterministicAlias(sameRecord, routeKey, held);
        });
        if (unserved.length === 0) continue;
        if (mergeUnservedRoutesIntoRecord(sameRecord, unserved)) {
          addRouteHolders(sliceRouteHolders, unserved);
          metadataChanged = true;
          continue;
        }
      }
      bySlug.set(entry.slug, entry);
      indexRecord(entry);
      added++;
    } else if (compareExpiredAt(entry.expiredAt, prev.expiredAt) >= 0) {
      const previousMetadata = firstSeenMetadata(prev);
      unindexRecord(prev); // the replaced record no longer owns its identities or routes
      bySlug.set(entry.slug, entry);
      const merged = mergeSourceIdentityHistory(entry, prev);
      indexRecord(entry); // after the merge: it may now carry the old record's identity history
      // A newer payload may replace a legacy entry that has no metadata. The
      // merge itself is intentionally a no-op when there is only one source
      // identity, so compare the selected payload before returning below.
      metadataChanged = merged
        || previousMetadata !== firstSeenMetadata(entry)
        || metadataChanged;
    } else {
      metadataChanged = mergeSourceIdentityHistory(prev, entry) || metadataChanged;
      // `prev` may have gained identities from `entry`'s history: keep the index in step.
      for (const identity of archiveRecordSourceIdentities(prev)) {
        let records = recordsBySourceIdentity.get(identity);
        if (!records) recordsBySourceIdentity.set(identity, records = new Set());
        records.add(prev);
      }
    }
  }

  const needsArchiveWrite = added > 0
    || bySlug.size !== sizeBefore
    || repaired > 0
    || metadataChanged;
  // Read and canonicalize even a clean archive: a previous writer may have
  // left two distinct source postings owning one historical route, and that
  // repair must not wait for an unrelated new removal.
  const collapsed = collapseDuplicateRouteEntries(
    [...bySlug.values()].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)),
    { source: 'archive-removed-jobs-to-slice' },
  );
  const archived = collapsed.entries;
  const routeRepair = Array.isArray(opts.activeJobs)
    ? repairExpiredRoutesAgainstActive(archived, opts.activeJobs)
    : { changed: 0 };
  const routeChanged = collapsed.collapsed > 0
    || collapsed.repairedRoutes > 0
    || routeRepair.changed > 0;
  if (!needsArchiveWrite && !routeChanged) return 0;
  // Per-file 90 MB ceiling + shard placement (expired-slice-store.mjs).
  writeExpiredSliceRows(crawlerKey, archived, { dir, existing: shards });
  return added;
}

/** Every locale-qualified URL token served by an active or expired record. */
export function localeRouteKeys(job = {}) {
  const routes = new Set();
  for (const locale of LOCALES) {
    const localeSlug = job.slugByLocale?.[locale];
    const current = localeSlug || (locale === 'it' ? job.slug : '');
    if (current) routes.add(`${locale}:${current}`);
    if (locale === 'it' && job.slug && (!localeSlug || localeSlug === job.slug)) {
      routes.add(`${locale}:${job.slug}`);
    }
    for (const slug of getPreviousSlugsForLocale(job, locale)) {
      if (slug) routes.add(`${locale}:${slug}`);
    }
  }
  return routes;
}

/**
 * Archive jobs removed by a publication-time filter.
 *
 * Unlike a source-slice disappearance, a Swiss gate drop happens after the
 * crawler has already handed the job to assembly. Keep the same SEO contract:
 * the active record may disappear, but its expired detail route must remain.
 * Existing slugs/routes are skipped before calling the normal archive writer
 * so a repeated assembly does not refresh `expiredAt` on every run.
 *
 * @param {Array<{job?: object, reason?: string}|object>} droppedRows
 * @param {{ dir?: string }} [opts]
 * @returns {{ added: number, skipped: number, byCrawler: Record<string, number> }}
 */
export function archiveFilteredJobsToSlices(droppedRows, opts = {}) {
  if (!Array.isArray(droppedRows) || droppedRows.length === 0) {
    return { added: 0, skipped: 0, byCrawler: {} };
  }

  const grouped = new Map();
  let skipped = 0;
  for (const row of droppedRows) {
    const job = row?.job && typeof row.job === 'object' ? row.job : row;
    // Legacy baseline rows can lack companyKey. They still have a public slug,
    // so keep them in a dedicated assembly slice instead of silently deleting
    // their expired page at the filter boundary.
    const crawlerKey = String(job?.companyKey || job?.crawlerKey || 'assembly-filtered').trim();
    if (!job?.slug || isHeldFromPublication(job)) {
      skipped++;
      continue;
    }
    if (!grouped.has(crawlerKey)) grouped.set(crawlerKey, []);
    grouped.get(crawlerKey).push(job);
  }

  let added = 0;
  const byCrawler = {};
  for (const [crawlerKey, jobs] of grouped) {
    const existing = readExpiredSlice(crawlerKey, opts);
    const existingSlugs = new Set(existing.map((entry) => entry?.slug).filter(Boolean));
    const existingRoutes = new Set(existing.flatMap((entry) => [...localeRouteKeys(entry)]));
    const candidates = jobs.filter((job) => {
      if (existingSlugs.has(job.slug)) return false;
      const routes = localeRouteKeys(job);
      return ![...routes].some((route) => existingRoutes.has(route));
    });
    const count = archiveRemovedJobsToSlice(candidates, crawlerKey, opts);
    if (count > 0) {
      added += count;
      byCrawler[crawlerKey] = count;
    }
  }

  return { added, skipped, byCrawler };
}

/** Preserve every route known by `removed` on `survivor`. */
export function transferSlugHistory(survivor, removed, source = 'reconcile-crawler-company-ownership') {
  if (removed?.previousSlugs != null && !Array.isArray(removed.previousSlugs)) {
    throw new TypeError('transferSlugHistory: removed.previousSlugs must be an array');
  }
  if (removed?.previousSlugsByLocale != null) {
    if (typeof removed.previousSlugsByLocale !== 'object' || Array.isArray(removed.previousSlugsByLocale)) {
      throw new TypeError('transferSlugHistory: removed.previousSlugsByLocale must be an object');
    }
    for (const [locale, slugs] of Object.entries(removed.previousSlugsByLocale)) {
      if (!Array.isArray(slugs)) {
        throw new TypeError(`transferSlugHistory: removed.previousSlugsByLocale.${locale} must be an array`);
      }
    }
  }
  let transferred = 0;
  const requiredRoutes = new Map(LOCALES.map((locale) => [
    locale,
    new Set([
      ...getPreviousSlugsForLocale(survivor, locale),
      ...getPreviousSlugsForLocale(removed, locale),
      ...(removed.slugByLocale?.[locale] ? [removed.slugByLocale[locale]] : []),
      ...(locale === 'it' && removed.slug ? [removed.slug] : []),
    ]),
  ]));
  const add = (locale, slug) => {
    if (!slug || slug === survivor.slugByLocale?.[locale]) return;
    const before = new Set(survivor.previousSlugsByLocale?.[locale] || []).size;
    addPreviousSlugForLocale(
      survivor,
      locale,
      slug,
      DEFAULT_PREV_SLUG_CAP,
      source,
    );
    const after = new Set(survivor.previousSlugsByLocale?.[locale] || []).size;
    if (after > before) transferred += 1;
  };

  for (const locale of LOCALES) {
    add(locale, removed.slugByLocale?.[locale]);
    for (const slug of removed.previousSlugsByLocale?.[locale] || []) add(locale, slug);
  }
  add('it', removed.slug);

  // A flat-only legacy slug has no locale provenance. The SEO bridge contract
  // deliberately serves it under every locale prefix. Attributing it to `it`
  // would silently remove the existing EN/DE/FR routes. Keep those entries
  // flat while locale-attributed history stays in its exact bucket.
  const attributed = new Set();
  for (const slugs of Object.values(removed.previousSlugsByLocale || {})) {
    if (Array.isArray(slugs)) for (const slug of slugs) attributed.add(slug);
  }
  const flatOnly = new Set(
    (removed.previousSlugs || []).filter((slug) => slug && !attributed.has(slug)),
  );
  for (const slug of flatOnly) {
    if (promotePreviousSlugToLegacy(
      survivor,
      slug,
      undefined,
      `${source}/flat-history`,
    )) transferred += 1;
  }

  // Merging two histories can overflow a 20-entry locale bucket. Promote an
  // evicted route to unattributed legacy history: that bucket remains capped,
  // while the old URL is still served (conservatively under every locale).
  for (const [locale, required] of requiredRoutes) {
    const served = new Set(getPreviousSlugsForLocale({
      ...survivor,
    }, locale));
    const activeSlug = survivor.slugByLocale?.[locale] || survivor.slug;
    if (activeSlug) served.add(activeSlug);
    for (const slug of required) {
      if (!slug || served.has(slug)) continue;
      promotePreviousSlugToLegacy(
        survivor,
        slug,
        undefined,
        `${source}/cap-overflow`,
      );
      served.add(slug);
      transferred += 1;
    }
  }
  return transferred;
}

const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Serialize route-bearing payloads independently of object insertion order. */
function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? '';
}

/** Canonical newest-first order, including the route payload as final tie-break. */
function compareArchiveEntries(a, b) {
  return compareExpiredAt(b?.expiredAt, a?.expiredAt)
    || compareCodeUnits(String(a?.slug || ''), String(b?.slug || ''))
    || compareCodeUnits(String(a?.companyKey || ''), String(b?.companyKey || ''))
    || compareCodeUnits(stableSerialize(a?.slugByLocale), stableSerialize(b?.slugByLocale))
    || compareCodeUnits(
      stableSerialize(a?.previousSlugsByLocale),
      stableSerialize(b?.previousSlugsByLocale),
    )
    || compareCodeUnits(stableSerialize(a?.previousSlugs), stableSerialize(b?.previousSlugs));
}

/**
 * Collapse archive entries that already share a locale route.
 *
 * The writers above key an archive by `slug` — the entry's CURRENT slug — but
 * the invariant the site actually needs is that every locale-qualified URL is
 * served by exactly one record. Two entries whose current slugs differ while
 * their `previousSlugs` overlap (a retired crawler alias surviving inside the
 * history of two vacancies) both pass a slug-keyed dedup and then own the same
 * route, which is what `assertNoDuplicateRoutesWithin` refuses.
 *
 * Routes are namespaced by `companyKey`: two companies may legitimately compute
 * the same slug (the collision class of issue #3734), and an entry without a
 * companyKey claims no route at all rather than merging across companies.
 *
 * The collapse is greedy and therefore sensitive to the order the conflicts
 * arrive in, so the entries are visited in a CANONICAL order and the "is this
 * route somebody else's?" question is answered from a pre-pass index of the
 * whole input rather than from the incremental one. Both used to be read off
 * the caller's array: reversing the input changed the output of 4 of the 547
 * committed slices (measured 2026-09-06), and a survivor could take a route
 * owned by an entry further down — a 301 to the wrong vacancy.
 *
 * A merge is applied only when it provably preserves the component's whole
 * route union. Two histories can be too deep to fit the legacy previousSlugs
 * cap, and `promotePreviousSlugToLegacy` correctly refuses to drop the
 * overflow; measured on 2026-09-05, 9 of the 547 committed slices hit that
 * wall. Such a component is left exactly as it was: a duplicated route is an
 * ambiguity, a lost route is a 404 on an indexed URL, and this runs inside the
 * crawler cron where a throw would abort the whole archival step. The residual
 * duplicates stay visible to `assertNoDuplicateRoutesWithin`.
 *
 * A component never mixes an entry that NAMES its source posting (url,
 * `sourceIdentity` or the `sourceIdentityHistory` an earlier merge left) with
 * one that names none. The survivor is chosen by expiredAt and then by slug,
 * never by evidence, so an identity-less member can become the payload every
 * real posting of the component collapses onto. Measured on the Rittmeyer
 * archive at 1c37bfda6c2d (2026-11-09): an identity-less record carrying the
 * Vitrea slugs of another company's old archive won the slug tie-break, the
 * "Sales Project Engineer (a) Ticino" posting collapsed onto it, and the
 * re-listed active row then inherited the Vitrea slug from the archive — its
 * indexed Rittmeyer URL became an unverified stub. Such an entry keeps its
 * routes (a lost route is a 404) and still counts as "somebody else's" holder
 * in the anti-theft check below, so no survivor can gain one of its routes.
 * Two legacy entries that BOTH lack an identity still collapse as before: there
 * is no posting for either of them to contaminate, and the retired-alias
 * repairs this function exists for are almost all of that shape.
 */
function collapseDuplicateRouteEntriesOnce(entries, { source = 'expired-archive-dedup' } = {}) {
  // Every route an entry holds, namespaced by company. Used to decide whether
  // a route a survivor would GAIN is already somebody else's.
  const namespaced = (entry) => (entry?.companyKey
    ? [...localeRouteKeys(entry)].map((route) => `${entry.companyKey}::${route}`)
    : []);
  // The routes an entry may MERGE through. The companyKey namespace is what
  // keeps two companies apart (a component never spans two companyKeys); the
  // identity class is what keeps an unattributable record from dictating the
  // survivor payload of a real posting (see the docblock above).
  const identityClasses = new Map();
  const identityClass = (entry) => {
    let cls = identityClasses.get(entry);
    if (!cls) {
      cls = archiveRecordSourceIdentities(entry).size > 0 ? 'named' : 'unnamed';
      identityClasses.set(entry, cls);
    }
    return cls;
  };
  const mergeRoutesOfClass = (entry, cls) => (entry?.companyKey
    ? [...localeRouteKeys(entry)].map((route) => `${entry.companyKey}::${cls}::${route}`)
    : []);
  const mergeRoutes = (entry) => mergeRoutesOfClass(entry, identityClass(entry));
  const otherClass = (entry) => (identityClass(entry) === 'named' ? 'unnamed' : 'named');
  let identityRefused = 0;
  // Entries are visited in a CANONICAL order, not the caller's. The collapse is
  // greedy — each entry is merged onto the component it already conflicts with —
  // so the order the conflicts arrive in decides which merges are attempted and
  // which are refused. Reading that order off the input made the result depend
  // on it: reversing the input changed the output of 4 of the 547 committed
  // slices (measured 2026-09-06), and `archiveRemovedJobsToSlice`,
  // `cleanup-jobs` and `backfill-*` do not all hand over the same order. Newest
  // first matches the survivor rule below (the most recently expired payload
  // wins); the slug/companyKey/payload tie-breaks keep two records expired in
  // the same millisecond from swapping roles.
  const input = [...entries].sort(compareArchiveEntries);
  const out = [];
  const owners = new Map();
  // The incremental index below answers "which SURVIVING entry holds this
  // route?" — it only ever knows the entries already processed. That is the
  // right answer for resolving a component, but the wrong one for the
  // anti-theft check further down, which asks "is this route somebody else's?"
  // and must count the entries still ahead in the input too. Answering it from
  // the incremental index made the result depend on input order: a survivor
  // that gained, via `promotePreviousSlugToLegacy`, a route belonging to a
  // later entry saw the route as free and stole it (a 301 to the wrong
  // vacancy). Measured on 2026-09-06, 4 of the 547 committed slices collapsed
  // differently when the input was reversed. This pre-pass indexes every
  // namespaced route of every input entry ONCE — O(n), never rebuilt, so the
  // complexity contract on `keep()` below still holds.
  const claimants = new Map();
  for (const entry of input) {
    for (const route of namespaced(entry)) {
      let holders = claimants.get(route);
      if (!holders) claimants.set(route, (holders = new Set()));
      holders.add(entry);
    }
  }
  // A survivor is a clone, absent from the pre-pass index, so a component
  // member cannot be matched against it by identity. Track which INPUT entries
  // each surviving record represents: that is what "my own component" means
  // once records start merging.
  const origins = new Map();
  let collapsed = 0;
  let slugsTransferred = 0;
  let unmergeable = 0;
  let capRefused = 0;
  // The index is maintained incrementally, never rebuilt: this runs over the
  // ~30k-entry aggregate archive, where a full rebuild per entry would be
  // quadratic. An entry whose merge was refused is kept in `out` but claims no
  // route, so a later entry cannot try (and fail) to collapse onto it again.
  const keep = (entry, { claimsRoutes = true, represents = [entry] } = {}) => {
    out.push(entry);
    origins.set(entry, new Set(represents));
    if (claimsRoutes) for (const route of mergeRoutes(entry)) owners.set(route, entry);
  };

  for (const entry of input) {
    // A shared route with an entry of the other identity class is left as it
    // is: counted here so the refusal is visible in the archive reports.
    if (mergeRoutesOfClass(entry, otherClass(entry)).some((route) => owners.has(route))) {
      identityRefused += 1;
    }
    const claimed = new Set(mergeRoutes(entry).map((route) => owners.get(route)).filter(Boolean));
    if (claimed.size === 0) {
      keep(entry);
      continue;
    }
    // One entry can bridge several previously separate records through
    // different locale/history routes: collapse the whole connected component
    // onto the most recently expired payload.
    const component = [...claimed, entry].sort(compareArchiveEntries);
    const required = new Set(component.flatMap(namespaced));
    const survivor = structuredClone(component[0]);
    const componentOrigins = new Set();
    for (const member of component) {
      for (const origin of origins.get(member) ?? [member]) componentOrigins.add(origin);
    }
    let transferred = 0;
    let merged = true;
    try {
      for (const removed of component) {
        if (removed === component[0]) continue;
        mergeSourceIdentityHistory(survivor, removed);
        transferred += transferSlugHistory(survivor, removed, source);
      }
    } catch (error) {
      // Only the legacy-bucket cap refusal is an expected outcome. Anything
      // else is a defect in the entry or in this code, and swallowing it would
      // make the component silently `unmergeable` — indistinguishable from a
      // legitimate refusal, and invisible in the cron log. The refusal is
      // recognised by TYPE, not by its message: the wording is a log string
      // that no gate protects, so a reword would abort the whole archival step
      // and an unrelated defect that happened to match would be swallowed.
      if (!isLegacyRouteCapRefusal(error)) throw error;
      merged = false;
      capRefused += 1;
    }
    if (merged) {
      const served = new Set(namespaced(survivor));
      // A gained route is free only if nobody else holds it — neither an
      // already-surviving record (incremental index) nor an input entry not yet
      // processed (pre-pass index). Consulting only the first made the verdict
      // depend on where the other holder happened to sit in the input.
      const heldByOthers = (route) => {
        if (owners.has(route)) return true;
        for (const holder of claimants.get(route) ?? []) {
          if (!componentOrigins.has(holder)) return true;
        }
        return false;
      };
      // `promotePreviousSlugToLegacy` moves a slug out of its per-locale bucket
      // into flat `previousSlugs`, which the SEO bridge serves under EVERY
      // locale prefix. The survivor can therefore gain routes neither original
      // entry served — and one of those may already belong to a third record.
      // Requiring the union is not enough: the gained routes must be free.
      merged = [...required].every((route) => served.has(route))
        && [...served].every((route) => required.has(route) || !heldByOthers(route));
    }
    if (!merged) {
      unmergeable += 1;
      keep(entry, { claimsRoutes: false });
      continue;
    }
    for (let index = out.length - 1; index >= 0; index -= 1) {
      if (!claimed.has(out[index])) continue;
      for (const route of mergeRoutes(out[index])) owners.delete(route);
      origins.delete(out[index]);
      out.splice(index, 1);
    }
    slugsTransferred += transferred;
    collapsed += component.length - 1;
    // Safe to re-add wholesale: the survivor was accepted only after proving it
    // serves the component's entire route union, so it re-claims every route
    // just deleted plus its own.
    keep(survivor, { represents: componentOrigins });
  }

  // A survivor is pushed at the position of the OLDEST member of its component
  // while carrying the NEWEST payload, so collapsing scrambles the expiredAt
  // ordering the callers rely on: `assemble-jobs-dataset` and `cleanup-jobs`
  // both `slice(0, EXPIRED_JOBS_CAP)` and document that cut as "the 5000 most
  // recent". Without this re-sort, 350 of the entries that belong in that
  // window fall past index 5000 and are dropped — the soft landings of the
  // jobs that expired last, i.e. the URLs Google indexed most recently.
  return {
    entries: out.sort(compareArchiveEntries),
    collapsed,
    slugsTransferred,
    unmergeable,
    capRefused,
    identityRefused,
  };
}

/**
 * The legacy-route cap can make a component unmergeable for one pass while a
 * different component is still removable. Removing that other component may
 * make the first component mergeable on the next pass, so every archive
 * writer must receive a fixed point rather than a merely sorted intermediate.
 *
 * Eight passes is the measured upper bound for the committed fixtures and is
 * deliberately finite: a cycle or a newly introduced non-convergent merge is
 * a correctness failure, not a reason to churn a large archive indefinitely.
 */
export const MAX_COLLAPSE_PASSES = 8;

/**
 * Hash an archive without materialising its complete JSON representation.
 *
 * The aggregate archive is already larger than V8's maximum string length.
 * `JSON.stringify(entries)` therefore throws before the first collapse pass,
 * even with ample heap. Feeding the same array framing and per-entry JSON to
 * SHA-256 keeps the fixed-point/cycle comparison order-sensitive while
 * bounding every intermediate string to one archive record.
 */
function archiveEntriesSignature(entries) {
  const hash = createHash('sha256');
  hash.update('[');
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0) hash.update(',');
    hash.update(JSON.stringify(entries[index]) ?? 'null');
  }
  hash.update(']');
  return hash.digest('hex');
}

export function collapseDuplicateRouteEntries(entries, options = {}) {
  const routeRepair = repairExpiredRoutesWithinArchive(entries, options);
  let current = entries;
  let currentSignature = archiveEntriesSignature(current);
  const seenSignatures = new Set([currentSignature]);
  let collapsed = 0;
  let slugsTransferred = 0;
  let firstPassCapRefused = 0;
  let repairedRoutes = routeRepair.repairedRoutes;
  const repairDetails = [...routeRepair.details];

  for (let pass = 0; pass < MAX_COLLAPSE_PASSES; pass += 1) {
    const result = collapseDuplicateRouteEntriesOnce(current, options);
    if (pass === 0) firstPassCapRefused = result.capRefused;
    collapsed += result.collapsed;
    slugsTransferred += result.slugsTransferred;

    // Collapsing a component can transfer a route from one survivor to
    // another. That transfer is route-preserving for the component, but it
    // can expose a distinct archive posting that now owns the same route as
    // the survivor. Repair the post-collapse state before deciding that the
    // archive reached a fixed point; otherwise the first writer pass can
    // persist a slice that a second read immediately changes again.
    const postCollapseRepair = repairExpiredRoutesWithinArchive(result.entries, options);
    repairedRoutes += postCollapseRepair.repairedRoutes;
    if (repairDetails.length < 20) {
      repairDetails.push(...postCollapseRepair.details.slice(0, 20 - repairDetails.length));
    }

    const nextSignature = archiveEntriesSignature(result.entries);
    if (nextSignature === currentSignature) {
      return {
        ...result,
        collapsed,
        slugsTransferred,
        // Preserve the pre-fixpoint meaning used by the archive reports:
        // this is the number refused by the first canonical pass. The final
        // pass is exposed separately for convergence diagnostics.
        capRefused: firstPassCapRefused,
        finalCapRefused: result.capRefused,
        repairedRoutes,
        repairDetails,
      };
    }

    if (seenSignatures.has(nextSignature)) {
      throw new Error(
        `expired archive route collapse did not converge: cycle detected after ${pass + 1} pass(es)`,
      );
    }
    seenSignatures.add(nextSignature);
    current = result.entries;
    currentSignature = nextSignature;
  }

  throw new Error(
    `expired archive route collapse did not converge after ${MAX_COLLAPSE_PASSES} passes`,
  );
}

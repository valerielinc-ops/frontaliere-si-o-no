#!/usr/bin/env node
/**
 * One-shot backfill: recover indexed-URL coverage for jobs that were dropped
 * by dedicated crawlers BEFORE the archival fix landed (PR #703).
 *
 * For each `data/jobs/by-crawler/<key>.json`, walk every commit that touched
 * the file. Any job (by `id`) that appeared in history but is no longer in
 * the current slice is "lost" — re-archive it into
 * `data/jobs/expired/by-crawler/<key>.json` using the most-recent historical
 * version of the job. Existing expired entries are preserved by company-scoped
 * route ownership;
 * historical expired entries that later disappeared from the archive are also
 * restored, and legacy entries receive sourceIdentity/firstSeenAt metadata
 * from the active-slice history. The same history pass repairs active slice
 * entries whose crawler-generated firstSeenAt was reset by a fresh rewrite;
 * otherwise the next company-alert run would still treat a standing vacancy
 * as new.
 * the on-disk shape matches what `runStandardCrawlerPipeline` would write
 * going forward, so the build plugin renders the same JobExpiredView.
 *
 * Run once, commit the resulting data diff. Subsequent crawl runs handle
 * fresh drops automatically.
 *
 * Usage:
 *   node scripts/backfill-expired-from-history.mjs           # all crawlers
 *   node scripts/backfill-expired-from-history.mjs upd       # one crawler
 *   node scripts/backfill-expired-from-history.mjs upd galenica  # several
 *
 * Env:
 *   DRY_RUN=1   — log what would change, don't write
 *   MAX_COMMITS=N — cap history depth per file (default: unbounded)
 *   CRAWLER_KEYS=key-a,key-b — restrict one run to a bounded crawler batch
 *   HISTORY_SINCE=<git date> — walk only commits newer than this ("all" = unbounded)
 */

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { mergeUrlKey } from './lib/job-url-key.mjs';
import { createCantonResolvers } from '../build-plugins/shared/cantonResolvers.mjs';
import {
  collapseDuplicateRouteEntries,
  createSameIdentityArchiveIndex,
  localeRouteKeys,
  mergeExpiredRouteEvidence,
  mergeSourceIdentityHistory,
  normalizeExpiredEntryTitles,
  normalizeExpiredAtEntries,
} from './lib/expired-jobs-archive.mjs';
import { addPreviousSlugForLocale, DEFAULT_PREV_SLUG_CAP } from './lib/dedicated-crawler-common.mjs';
import { replaceSlugRouteEverywhere } from './lib/slug-history-journal.mjs';
import { ACTIVE_JOB_PAGE_LOCALES, localizedActiveJobSlug } from '../build-plugins/shared/activeJobPageSelection.ts';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import {
  listExpiredSliceFiles,
  parseExpiredSliceFileName,
  readExpiredSliceShards,
  writeExpiredSliceRows,
} from './lib/expired-slice-store.mjs';
import { historySinceArgs } from './ci/prefetch-history-blobs.mjs';
import { compareExpiredAt } from './lib/compare-expired-at.mjs';
import {
  archiveRecordNamesPosting,
  archiveRecordSourceIdentities,
  buildStableJobIdentity,
} from './lib/job-identity.mjs';
import { ambiguousJobIdentities, createFirstSeenMetadataIndex } from './lib/first-seen-history.mjs';
import { isHeldFromPublication } from './lib/translation-publication-hold.mjs';
import { resolveExpiredRouteCanton, setExpiredRouteCanton } from './lib/expired-route-canton.mjs';
import { stableStringify } from './lib/stable-stringify.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');
const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({
  cantonSlugFile: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-url-slugs.json'), 'utf-8')),
  municipalitiesFile: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'canton-municipalities.json'), 'utf-8')),
});

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_COMMITS = process.env.MAX_COMMITS ? Number(process.env.MAX_COMMITS) : 0;

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const envKeys = String(process.env.CRAWLER_KEYS || '')
  .split(/[\s,]+/u)
  .map((key) => key.trim())
  .filter(Boolean);
const onlyKeys = new Set([...argv, ...envKeys]);

function git(args, { quiet = false, cwd = ROOT } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    ...(quiet ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}),
  });
}

function readJobsFromSlice(blob) {
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed.jobs;
  return [];
}

function invalidHistoricalRow(family, relPath, sha, index, detail) {
  throw new Error(
    `Historical JSON ${family} row ${index} is unusable for ${relPath} at ${sha}: ${detail}`,
  );
}

function validateHistoricalRow(job, family, relPath, sha, index) {
  const fail = (field, detail = 'has an unsupported type') => (
    invalidHistoricalRow(family, relPath, sha, index, `${field} ${detail}`)
  );
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const isOptionalString = (value) => value == null || typeof value === 'string';
  const isOptionalId = (value) => value == null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));

  for (const field of ['slug', 'url', 'applyUrl', 'sourceIdentity', 'companyKey', 'canton', 'title', 'company', 'location', 'expiredAt', 'firstSeenAt']) {
    if (!isOptionalString(job[field])) fail(field);
  }
  for (const field of ['id', 'externalId', 'jobId']) {
    if (!isOptionalId(job[field])) fail(field);
  }
  if (job.slugByLocale != null) {
    if (!isObject(job.slugByLocale)) fail('slugByLocale');
    if (Object.values(job.slugByLocale).some((slug) => !isOptionalString(slug))) {
      fail('slugByLocale values');
    }
  }
  if (job.previousSlugs != null) {
    if (!Array.isArray(job.previousSlugs)) fail('previousSlugs');
    if (job.previousSlugs.some((slug) => typeof slug !== 'string')) fail('previousSlugs entries');
  }
  for (const field of ['previousSlugsByLocale']) {
    if (job[field] == null) continue;
    if (!isObject(job[field])) fail(field);
    for (const slugs of Object.values(job[field])) {
      if (!Array.isArray(slugs) || slugs.some((slug) => typeof slug !== 'string')) {
        fail(`${field} values`);
      }
    }
  }
  if (job.previousSlugCantonByLocale != null) {
    if (!isObject(job.previousSlugCantonByLocale)) fail('previousSlugCantonByLocale');
    for (const cantons of Object.values(job.previousSlugCantonByLocale)) {
      if (!isObject(cantons) || Object.values(cantons).some((canton) => !isOptionalString(canton))) {
        fail('previousSlugCantonByLocale values');
      }
    }
  }
  if (job.sourceIdentityHistory != null) {
    if (!Array.isArray(job.sourceIdentityHistory)) fail('sourceIdentityHistory');
    for (const history of job.sourceIdentityHistory) {
      if (!isObject(history)) fail('sourceIdentityHistory entries');
      for (const field of ['id', 'externalId', 'jobId']) {
        if (!isOptionalId(history[field])) fail(`sourceIdentityHistory.${field}`);
      }
      for (const field of ['url', 'sourceIdentity', 'firstSeenAt', 'title']) {
        if (!isOptionalString(history[field])) fail(`sourceIdentityHistory.${field}`);
      }
    }
  }

  const active = family === 'active crawler slice';
  let routes;
  try {
    routes = emittedRouteEntries(job, { active });
  } catch {
    fail('route fields', 'cannot produce a recoverable emitted route');
  }
  if (!routes.some(({ slug }) => typeof slug === 'string' && slug.trim())) {
    fail('route fields', 'do not produce a recoverable emitted route');
  }
}

/** Historical data must not silently turn into an empty snapshot. */
function readHistoricalJobs(blob, relPath, sha, family) {
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch {
    throw new Error(`Historical JSON for ${family} is invalid for ${relPath} at ${sha}`);
  }
  const jobs = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : null;
  if (!jobs) throw new Error(`Historical JSON has an unsupported root shape for ${family} at ${relPath} at ${sha}`);
  for (let index = 0; index < jobs.length; index += 1) {
    const row = jobs[index];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      invalidHistoricalRow(family, relPath, sha, index, 'is not an object');
    }
    validateHistoricalRow(row, family, relPath, sha, index);
  }
  return jobs;
}

function payloadFingerprint(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function compactStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string'));
}

function compactStringArrayMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, items]) => Array.isArray(items))
    .map(([key, items]) => [key, items.filter((item) => typeof item === 'string')]));
}

function compactStringObjectMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, entries]) => entries && typeof entries === 'object' && !Array.isArray(entries))
    .map(([key, entries]) => [key, compactStringMap(entries)]));
}

/** Only fields used by identity proof, ambiguity grouping, and emitted routes. */
function compactOwnerEvidence(job, { active = false, identityOnly = false } = {}) {
  const identityFields = {};
  for (const key of ['id', 'externalId', 'jobId', 'url', 'sourceIdentity']) {
    if (job?.[key] !== undefined) identityFields[key] = job[key];
  }
  if (Array.isArray(job?.sourceIdentityHistory)) {
    identityFields.sourceIdentityHistory = job.sourceIdentityHistory
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => {
        const identity = {};
        for (const key of ['id', 'externalId', 'jobId', 'url', 'sourceIdentity']) {
          if (entry[key] !== undefined) identity[key] = entry[key];
        }
        return identity;
      });
  }
  if (identityOnly) return { ...identityFields, companyKey: String(job?.companyKey || '') };
  const routeFields = {
    ...(typeof job?.slug === 'string' ? { slug: job.slug } : {}),
    slugByLocale: compactStringMap(job?.slugByLocale),
    previousSlugs: Array.isArray(job?.previousSlugs)
      ? job.previousSlugs.filter((slug) => typeof slug === 'string')
      : [],
    previousSlugsByLocale: compactStringArrayMap(job?.previousSlugsByLocale),
    previousSlugCantonByLocale: compactStringObjectMap(job?.previousSlugCantonByLocale),
  };
  return {
    ...identityFields,
    companyKey: String(job?.companyKey || ''),
    ...routeFields,
    routeEntries: emittedRouteEntries(job || {}, { active }),
  };
}

const OWNER_IDENTITY_ROUTE_FIELDS = new Set([
  'slug',
  'slugByLocale',
  'previousSlugs',
  'previousSlugsByLocale',
  'previousSlugCantonByLocale',
  'routeEntries',
]);

function compactOwnerIdentityEvidence(job) {
  // The identity half of compactOwnerEvidence, without computing the route
  // half (emitted routes, slug maps) only to filter it out again.
  const evidence = compactOwnerEvidence(job, { identityOnly: true });
  return Object.fromEntries(Object.entries(evidence)
    .filter(([key]) => !OWNER_IDENTITY_ROUTE_FIELDS.has(key)));
}

function historicalOwnerAccumulatorKey(identityEvidence, fingerprint) {
  const identityKey = stableStringify(identityEvidence);
  const hasPostingIdentity = [...archiveRecordSourceIdentities(identityEvidence || {})]
    .some((identity) => namesOnePosting(identity));
  // Company and listing-page identities do not prove that distinct legacy
  // rows belong to one posting. Keep each payload's compact evidence apart;
  // exact repeated snapshots still deduplicate by their stable fingerprint.
  return hasPostingIdentity ? identityKey : stableStringify([identityEvidence, fingerprint]);
}

function compactActiveRoutePayload(job) {
  return {
    ...(typeof job?.slug === 'string' ? { slug: job.slug } : {}),
    slugByLocale: compactStringMap(job?.slugByLocale),
    previousSlugs: Array.isArray(job?.previousSlugs)
      ? job.previousSlugs.filter((slug) => typeof slug === 'string')
      : [],
    previousSlugsByLocale: compactStringArrayMap(job?.previousSlugsByLocale),
    previousSlugCantonByLocale: compactStringObjectMap(job?.previousSlugCantonByLocale),
  };
}

function rebuildOwnerEvidence(owner, routeJob = {}) {
  const previousSlugsByLocale = Object.fromEntries([...owner.routeSlugsByLocale].map(([locale, slugs]) => (
    [locale, [...slugs]]
  )));
  const previousSlugCantonByLocale = Object.fromEntries([...owner.routeCantonsByLocale].map(([locale, cantons]) => (
    [locale, Object.fromEntries(cantons)]
  )));
  owner.evidence = {
    ...owner.identityEvidence,
    ...(typeof routeJob?.slug === 'string' ? { slug: routeJob.slug } : {}),
    slugByLocale: compactStringMap(routeJob?.slugByLocale),
    previousSlugs: [...new Set([...owner.routeSlugsByLocale.values()].flatMap((slugs) => [...slugs]))],
    previousSlugsByLocale,
    previousSlugCantonByLocale,
    routeEntries: [...owner.routeEvidenceByPath.values()],
  };
}

function refreshOwnerRouteEvidence(owner, routeJob, { active = false } = {}) {
  owner.routeEvidenceByPath ||= new Map();
  owner.routeSlugsByLocale ||= new Map();
  owner.routeCantonsByLocale ||= new Map();
  for (const route of emittedRouteEntries(routeJob, { active })) {
    const routeKey = stableStringify([route.localeSlugKey, route.emittedPath, route.canton || '']);
    owner.routeEvidenceByPath.set(routeKey, route);
    const slugs = owner.routeSlugsByLocale.get(route.locale) || new Set();
    slugs.add(route.slug);
    owner.routeSlugsByLocale.set(route.locale, slugs);
    const cantons = owner.routeCantonsByLocale.get(route.locale) || new Map();
    if (route.canton && !cantons.has(route.slug)) cantons.set(route.slug, route.canton);
    owner.routeCantonsByLocale.set(route.locale, cantons);
  }
  rebuildOwnerEvidence(owner, routeJob);
}

function addHistoricalOwnerSighting(index, job, { active = false, retainPayload = false } = {}) {
  const identityEvidence = compactOwnerIdentityEvidence(job);
  const fingerprint = payloadFingerprint(job);
  const key = historicalOwnerAccumulatorKey(identityEvidence, fingerprint);
  let owner = index.get(key);
  if (!owner) {
    owner = {
      identityEvidence,
      evidence: null,
      firstPayloadFingerprint: fingerprint,
      hasDistinctPayload: false,
      ...(retainPayload ? { representative: job } : {}),
    };
    index.set(key, owner);
  }
  if (owner.firstPayloadFingerprint !== fingerprint) owner.hasDistinctPayload = true;
  if (retainPayload) {
    if (compareExpiredAt(owner.representative?.expiredAt, job?.expiredAt) < 0) {
      mergeSourceIdentityHistory(job, owner.representative);
      owner.representative = job;
    } else {
      mergeSourceIdentityHistory(owner.representative, job);
    }
  }
  refreshOwnerRouteEvidence(owner, job, { active });
  return owner;
}

function historicalOwnerIdentityEvidence(owner) {
  const evidence = { companyKey: owner.companyKey };
  const representative = owner.representative || {};
  const commonIdentities = owner.commonPostingIdentities;
  const rawId = representative.id ?? representative.externalId ?? representative.jobId;
  if (rawId != null && commonIdentities.has(`id:${String(rawId).trim().toLowerCase()}`)) {
    evidence.id = rawId;
  }
  if (typeof representative.url === 'string'
    && commonIdentities.has(buildStableJobIdentity({ url: representative.url }))) {
    evidence.url = representative.url;
  }

  const declared = [...owner.commonDeclaredIdentities].sort();
  const primary = declared.includes(representative.sourceIdentity)
    ? representative.sourceIdentity
    : declared[0];
  if (primary) evidence.sourceIdentity = primary;
  const history = declared.filter((identity) => identity !== primary);
  if (history.length > 0) {
    evidence.sourceIdentityHistory = history.map((sourceIdentity) => ({ sourceIdentity }));
  }
  return evidence;
}

const POSTING_NAME_MEMO_LIMIT = 200000;
let postingNameMemo = new Map();
/** Pure in `identity`; the same few identities recur on every archive version. */
function namesOnePostingMemo(identity) {
  let named = postingNameMemo.get(identity);
  if (named === undefined) {
    named = namesOnePosting(identity);
    if (postingNameMemo.size >= POSTING_NAME_MEMO_LIMIT) postingNameMemo = new Map();
    postingNameMemo.set(identity, named);
  }
  return named;
}

// Values derived from one archive entry are pure functions of its content, and
// successive archive versions repeat almost every entry. Keyed by the digest of
// the entry's stable JSON (the very string the payload fingerprint hashes), so
// an entry parsed again from a newer blob reuses them. Two generations bound
// the memory: a full generation is retired only after the next one fills.
const ENTRY_DERIVED_LIMIT = 40000;
let entryDerivedCurrent = new Map();
let entryDerivedPrevious = new Map();
// The walk calls collector.add(entry) and then listing.addArchiveRow(entry) on
// the same object with nothing in between, so the second call reuses the first
// call's digest. Only the second call trusts the slot, and it empties it, so an
// object mutated and re-added is always re-hashed.
let lastAddedEntry = null;
let lastAddedDerived = null;

/**
 * Pure per-entry values shared by the owner collector and the listing index.
 * Consumers must treat every field as read-only (copy before mutating).
 */
function derivedForEntry(job, { reuseLastAdded = false } = {}) {
  if (reuseLastAdded && job !== null && typeof job === 'object' && job === lastAddedEntry) {
    const reused = lastAddedDerived;
    lastAddedEntry = null;
    lastAddedDerived = null;
    return reused;
  }
  const stable = stableStringify(job);
  const digest = createHash('sha1').update(stable).digest('base64');
  let derived = entryDerivedCurrent.get(digest);
  if (derived === undefined) {
    derived = entryDerivedPrevious.get(digest);
    if (derived === undefined) {
      derived = { stable, owner: null, listing: null };
    }
    if (entryDerivedCurrent.size >= ENTRY_DERIVED_LIMIT) {
      entryDerivedPrevious = entryDerivedCurrent;
      entryDerivedCurrent = new Map();
    }
    entryDerivedCurrent.set(digest, derived);
  }
  return derived;
}

/** Drops every memoized per-entry value (tests compare cold against hot runs). */
export function resetHistoricalEntryMemo() {
  entryDerivedCurrent = new Map();
  entryDerivedPrevious = new Map();
  postingNameMemo = new Map();
  lastAddedEntry = null;
  lastAddedDerived = null;
}

/** Collector inputs of one entry; computed once per distinct entry content. */
function ownerDerivedForEntry(job) {
  const derived = derivedForEntry(job);
  lastAddedEntry = job !== null && typeof job === 'object' ? job : null;
  lastAddedDerived = lastAddedEntry ? derived : null;
  if (derived.owner) return derived.owner;
  const proofIdentities = new Set([...archiveRecordSourceIdentities(job)].filter(namesOnePostingMemo));
  const identityEvidence = compactOwnerIdentityEvidence(job);
  const fingerprint = createHash('sha256').update(derived.stable).digest('hex');
  derived.owner = {
    companyKey: String(job?.companyKey || ''),
    proofIdentities,
    declaredIdentities: declaredPostingIdentities(job),
    identityEvidence,
    fingerprint,
    exactKey: stableStringify([identityEvidence, fingerprint]),
    routes: emittedRouteEntries(job, { active: false }).map((route) => ({
      route,
      routeKey: stableStringify([route.localeSlugKey, route.emittedPath, route.canton || '']),
    })),
  };
  derived.stable = null;
  return derived.owner;
}

/**
 * Collect expired history with one full payload per proven posting. The proof
 * set is intersected on every merge, so a pairwise chain cannot turn into a
 * transitive posting match. Listing URLs never enter the posting proof set.
 */
export function createHistoricalExpiredOwnerCollector() {
  const owners = [];
  const ownersByCompanyIdentity = new Map();
  const exactPayloads = new Map();
  const proofIndexKey = (companyKey, identity) => JSON.stringify([companyKey, identity]);

  const add = (job) => {
    const derived = ownerDerivedForEntry(job);
    const {
      companyKey,
      proofIdentities,
      declaredIdentities,
      identityEvidence,
      fingerprint,
      exactKey,
    } = derived;
    const duplicate = exactPayloads.get(exactKey);
    const candidates = new Set();
    for (const identity of proofIdentities) {
      for (const owner of ownersByCompanyIdentity.get(proofIndexKey(companyKey, identity)) || []) {
        candidates.add(owner);
      }
    }
    const matching = [...candidates].filter((owner) => {
      if (owner.companyKey !== companyKey
        || ![...owner.commonPostingIdentities].some((identity) => proofIdentities.has(identity))) return false;
      return declaredIdentities.size === 0
        || !owner.hasDeclaredIdentities
        || [...owner.commonDeclaredIdentities].some((identity) => declaredIdentities.has(identity));
    });

    let owner = matching.length === 1 ? matching[0] : duplicate;
    if (!owner) {
      owner = {
        companyKey,
        representative: job,
        commonPostingIdentities: new Set(proofIdentities),
        commonDeclaredIdentities: new Set(declaredIdentities),
        observedPostingIdentities: new Set(proofIdentities),
        observedDeclaredIdentities: new Set(declaredIdentities),
        hasDeclaredIdentities: declaredIdentities.size > 0,
        identityEvidence,
        evidence: null,
        firstPayloadFingerprint: fingerprint,
        hasDistinctPayload: false,
        routeEvidenceByPath: new Map(),
        routeSlugsByLocale: new Map(),
        routeCantonsByLocale: new Map(),
      };
      owners.push(owner);
    } else {
      if (owner.firstPayloadFingerprint !== fingerprint) owner.hasDistinctPayload = true;
      for (const identity of proofIdentities) owner.observedPostingIdentities.add(identity);
      for (const identity of declaredIdentities) owner.observedDeclaredIdentities.add(identity);
      for (const identity of owner.commonPostingIdentities) {
        if (!proofIdentities.has(identity)) owner.commonPostingIdentities.delete(identity);
      }
      if (declaredIdentities.size > 0) {
        if (!owner.hasDeclaredIdentities) {
          owner.commonDeclaredIdentities = new Set(declaredIdentities);
          owner.hasDeclaredIdentities = true;
        } else {
          for (const identity of owner.commonDeclaredIdentities) {
            if (!declaredIdentities.has(identity)) owner.commonDeclaredIdentities.delete(identity);
          }
        }
      }
      if (compareExpiredAt(owner.representative?.expiredAt, job?.expiredAt) < 0) {
        owner.representative = job;
      }
    }

    owner.identityEvidence = historicalOwnerIdentityEvidence(owner);
    // Same effect as refreshOwnerRouteEvidence(owner, job) followed by the
    // rebuild below; the rebuild that function ends with is overwritten here,
    // so it runs once, from the representative.
    for (const { route: derivedRoute, routeKey } of derived.routes) {
      const route = { ...derivedRoute };
      owner.routeEvidenceByPath.set(routeKey, route);
      const slugs = owner.routeSlugsByLocale.get(route.locale) || new Set();
      slugs.add(route.slug);
      owner.routeSlugsByLocale.set(route.locale, slugs);
      const cantons = owner.routeCantonsByLocale.get(route.locale) || new Map();
      if (route.canton && !cantons.has(route.slug)) cantons.set(route.slug, route.canton);
      owner.routeCantonsByLocale.set(route.locale, cantons);
    }
    rebuildOwnerEvidence(owner, owner.representative);
    exactPayloads.set(exactKey, owner);
    for (const identity of owner.commonPostingIdentities) {
      const key = proofIndexKey(companyKey, identity);
      const group = ownersByCompanyIdentity.get(key) || new Set();
      group.add(owner);
      ownersByCompanyIdentity.set(key, group);
    }
    return owner;
  };

  return {
    add,
    values: () => owners.values(),
  };
}

// Pure values derived from one ACTIVE-slice job. The active walk re-reads a
// slice of ~10k jobs on almost every commit and most jobs are unchanged. Rows
// come from JSON.parse, so JSON.stringify is a faithful content key.
const ACTIVE_DERIVED_LIMIT = 30000;
let activeDerivedCurrent = new Map();
let activeDerivedPrevious = new Map();

function activeDerivedForJob(job) {
  const digest = createHash('sha1').update(JSON.stringify(job)).digest('base64');
  let derived = activeDerivedCurrent.get(digest);
  if (derived === undefined) {
    derived = activeDerivedPrevious.get(digest);
    if (derived === undefined) derived = { digest, job: null };
    if (activeDerivedCurrent.size >= ACTIVE_DERIVED_LIMIT) {
      activeDerivedPrevious = activeDerivedCurrent;
      activeDerivedCurrent = new Map();
    }
    activeDerivedCurrent.set(digest, derived);
  }
  if (derived.held === undefined) {
    derived.held = isHeldFromPublication(job);
    derived.routes = emittedRouteEntries(job, { active: true });
    derived.routeKeys = new Set(derived.routes.map(({ emittedPath }) => emittedPath));
    derived.routePaths = [...derived.routeKeys];
    derived.firstSeen = {};
    derived.owner = null;
    derived.idless = null;
    derived.evidence = null;
  }
  return derived;
}

function activeOwnerDerived(job, derived) {
  if (derived.owner) return derived.owner;
  const identityEvidence = compactOwnerIdentityEvidence(job);
  const fingerprint = payloadFingerprint(job);
  derived.owner = {
    identityEvidence,
    fingerprint,
    accumulatorKey: historicalOwnerAccumulatorKey(identityEvidence, fingerprint),
    routes: derived.routes.map((route) => ({
      route,
      routeKey: stableStringify([route.localeSlugKey, route.emittedPath, route.canton || '']),
    })),
  };
  return derived.owner;
}

/**
 * addHistoricalOwnerSighting(index, job, { active: true }) with the pure
 * derivation memoized. When the owner's last applied job has identical
 * content, its route maps and evidence already equal what re-applying would
 * produce (they depend only on the maps and that job), so only that work is
 * skipped.
 */
function addActiveHistoricalOwnerSighting(index, job, derived) {
  const values = activeOwnerDerived(job, derived);
  let owner = index.get(values.accumulatorKey);
  if (!owner) {
    owner = {
      identityEvidence: values.identityEvidence,
      evidence: null,
      firstPayloadFingerprint: values.fingerprint,
      hasDistinctPayload: false,
    };
    index.set(values.accumulatorKey, owner);
  }
  if (owner.firstPayloadFingerprint !== values.fingerprint) owner.hasDistinctPayload = true;
  if (owner.lastAppliedDigest === derived.digest && owner.evidence) return owner;
  owner.routeEvidenceByPath ||= new Map();
  owner.routeSlugsByLocale ||= new Map();
  owner.routeCantonsByLocale ||= new Map();
  for (const { route: sharedRoute, routeKey } of values.routes) {
    const route = { ...sharedRoute };
    owner.routeEvidenceByPath.set(routeKey, route);
    const slugs = owner.routeSlugsByLocale.get(route.locale) || new Set();
    slugs.add(route.slug);
    owner.routeSlugsByLocale.set(route.locale, slugs);
    const cantons = owner.routeCantonsByLocale.get(route.locale) || new Map();
    if (route.canton && !cantons.has(route.slug)) cantons.set(route.slug, route.canton);
    owner.routeCantonsByLocale.set(route.locale, cantons);
  }
  rebuildOwnerEvidence(owner, job);
  owner.lastAppliedDigest = derived.digest;
  return owner;
}

function mergeHistoricalOwnerAccumulator(index, incoming) {
  const key = historicalOwnerAccumulatorKey(incoming.identityEvidence, incoming.firstPayloadFingerprint);
  const current = index.get(key);
  if (!current) {
    index.set(key, incoming);
    return;
  }
  if (current.firstPayloadFingerprint !== incoming.firstPayloadFingerprint
    || incoming.hasDistinctPayload) current.hasDistinctPayload = true;
  if (!current.representative) {
    current.representative = incoming.representative;
  } else if (incoming.representative
    && compareExpiredAt(current.representative.expiredAt, incoming.representative.expiredAt) < 0) {
    if (current.representative) mergeSourceIdentityHistory(incoming.representative, current.representative);
    current.representative = incoming.representative;
  } else if (current.representative && incoming.representative) {
    mergeSourceIdentityHistory(current.representative, incoming.representative);
  }
  for (const route of incoming.routeEvidenceByPath?.values() || []) {
    const routeKey = stableStringify([route.localeSlugKey, route.emittedPath, route.canton || '']);
    current.routeEvidenceByPath ||= new Map();
    current.routeEvidenceByPath.set(routeKey, route);
    const slugs = current.routeSlugsByLocale?.get(route.locale) || new Set();
    slugs.add(route.slug);
    current.routeSlugsByLocale ||= new Map();
    current.routeSlugsByLocale.set(route.locale, slugs);
    const cantons = current.routeCantonsByLocale?.get(route.locale) || new Map();
    if (route.canton && !cantons.has(route.slug)) cantons.set(route.slug, route.canton);
    current.routeCantonsByLocale ||= new Map();
    current.routeCantonsByLocale.set(route.locale, cantons);
  }
  rebuildOwnerEvidence(current, current.representative || incoming.evidence);
}

function materializeHistoricalOwnerRoutes(owner) {
  const source = owner?.representative;
  if (!source) return null;
  const representative = { ...source };
  for (const field of ['id', 'externalId', 'jobId', 'url', 'sourceIdentity', 'sourceIdentityHistory']) {
    if (Object.hasOwn(owner.identityEvidence || {}, field)) {
      representative[field] = owner.identityEvidence[field];
    } else {
      delete representative[field];
    }
  }
  const currentPaths = new Map(emittedRouteEntries(representative).map((route) => [
    route.localeSlugKey,
    route.emittedPath,
  ]));
  const routesByLocale = {};
  const cantonsByLocale = {};
  for (const route of owner.routeEvidenceByPath?.values() || []) {
    if (currentPaths.get(route.localeSlugKey) === route.emittedPath) continue;
    if (currentPaths.has(route.localeSlugKey)) {
      throw new Error('Historical route evidence has two canton-qualified paths for one locale slug');
    }
    (routesByLocale[route.locale] ||= []).push(route.slug);
    if (route.canton) (cantonsByLocale[route.locale] ||= {})[route.slug] = route.canton;
  }
  mergeExpiredRouteEvidence(
    representative,
    { previousSlugsByLocale: routesByLocale, previousSlugCantonByLocale: cantonsByLocale },
    'backfill-expired-from-history/historical-owner-routes',
  );
  return representative;
}

function expandOwnerEvidence(owners, listingIdentities) {
  const expanded = [];
  for (const owner of owners.values()) {
    const hasUnambiguousPostingIdentity = [...archiveRecordSourceIdentities(owner.evidence)].some((identity) => (
      namesOnePosting(identity) && !listingIdentities.isAmbiguous(identity)
    ));
    const duplicateUnprovenOwner = owner.hasDistinctPayload && !hasUnambiguousPostingIdentity;
    expanded.push(owner.evidence);
    if (duplicateUnprovenOwner) expanded.push({ ...owner.evidence });
  }
  return expanded;
}

function routeOwnerProofKey(job, kind, route, isAmbiguousIdentity) {
  const identities = [...archiveRecordSourceIdentities(job)];
  const proven = identities.filter((identity) => (
    namesOnePosting(identity) && !isAmbiguousIdentity(identity)
  )).sort();
  if (proven.length === 0) return '';
  const declared = [
    job?.sourceIdentity,
    ...(Array.isArray(job?.sourceIdentityHistory)
      ? job.sourceIdentityHistory.map((entry) => entry?.sourceIdentity)
      : []),
  ].filter((identity) => typeof identity === 'string' && identity.trim()).sort();
  return stableStringify([
    kind,
    String(job?.companyKey || ''),
    route.localeSlugKey,
    route.emittedPath,
    proven,
    declared,
  ]);
}

function mergeHistoricalRecoveryRepresentatives(rows, isAmbiguousIdentity) {
  const owners = [];
  const byCompanyIdentity = new Map();
  const byCompanyIdentityAndDeclaration = new Map();
  const byCompanyIdentityWithoutDeclaration = new Map();
  const indexKey = (companyKey, identity) => JSON.stringify([companyKey, identity]);
  const declarationIndexKey = (companyKey, identity, declaration) => (
    JSON.stringify([companyKey, identity, declaration])
  );
  const proofIdentitiesOf = (row) => new Set([...archiveRecordSourceIdentities(row)].filter((identity) => (
    namesOnePosting(identity) && !isAmbiguousIdentity(identity)
  )));
  const indexOwner = (owner, add) => {
    for (const identity of owner.commonPostingIdentities) {
      const key = indexKey(owner.companyKey, identity);
      const all = byCompanyIdentity.get(key) || new Set();
      if (add) all.add(owner);
      else all.delete(owner);
      if (all.size > 0) byCompanyIdentity.set(key, all);
      else byCompanyIdentity.delete(key);

      if (!owner.hasDeclaredIdentities) {
        const withoutDeclaration = byCompanyIdentityWithoutDeclaration.get(key) || new Set();
        if (add) withoutDeclaration.add(owner);
        else withoutDeclaration.delete(owner);
        if (withoutDeclaration.size > 0) byCompanyIdentityWithoutDeclaration.set(key, withoutDeclaration);
        else byCompanyIdentityWithoutDeclaration.delete(key);
      } else {
        for (const declaration of owner.commonDeclaredIdentities) {
          const declaredKey = declarationIndexKey(owner.companyKey, identity, declaration);
          const declared = byCompanyIdentityAndDeclaration.get(declaredKey) || new Set();
          if (add) declared.add(owner);
          else declared.delete(owner);
          if (declared.size > 0) byCompanyIdentityAndDeclaration.set(declaredKey, declared);
          else byCompanyIdentityAndDeclaration.delete(declaredKey);
        }
      }
    }
  };
  const createOwner = (row) => {
    const declared = declaredPostingIdentities(row);
    const owner = {
      representative: row,
      companyKey: String(row?.companyKey || ''),
      commonPostingIdentities: proofIdentitiesOf(row),
      commonDeclaredIdentities: declared,
      hasDeclaredIdentities: declared.size > 0,
    };
    owners.push(owner);
    indexOwner(owner, true);
    return owner;
  };
  const matchesEveryOwner = (owner, row, rowProof, rowDeclared) => {
    if (![...owner.commonPostingIdentities].some((identity) => rowProof.has(identity))) return false;
    if (rowDeclared.size > 0 && owner.hasDeclaredIdentities
      && ![...owner.commonDeclaredIdentities].some((identity) => rowDeclared.has(identity))) return false;
    return true;
  };
  const sorted = [...rows].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt));
  for (const row of sorted) {
    const companyKey = String(row?.companyKey || '');
    const rowProof = proofIdentitiesOf(row);
    const rowDeclared = declaredPostingIdentities(row);
    const possibleOwners = new Set();
    for (const identity of rowProof) {
      const key = indexKey(companyKey, identity);
      if (rowDeclared.size === 0) {
        for (const owner of byCompanyIdentity.get(key) || []) {
          possibleOwners.add(owner);
          if (possibleOwners.size > 1) break;
        }
      } else {
        for (const owner of byCompanyIdentityWithoutDeclaration.get(key) || []) {
          possibleOwners.add(owner);
          if (possibleOwners.size > 1) break;
        }
        if (possibleOwners.size > 1) break;
        for (const declaration of rowDeclared) {
          const declaredKey = declarationIndexKey(companyKey, identity, declaration);
          for (const owner of byCompanyIdentityAndDeclaration.get(declaredKey) || []) {
            possibleOwners.add(owner);
            if (possibleOwners.size > 1) break;
          }
          if (possibleOwners.size > 1) break;
        }
      }
      if (possibleOwners.size > 1) break;
    }
    const matchingOwners = [...possibleOwners].filter((owner) => (
      owner.companyKey === companyKey && matchesEveryOwner(owner, row, rowProof, rowDeclared)
    ));
    if (matchingOwners.length !== 1) {
      createOwner(row);
      continue;
    }

    const [owner] = matchingOwners;
    const newer = owner.representative;
    const candidate = structuredClone(newer);
    const olderRoutes = emittedRouteKeys(row);
    let routeCapRefused = false;
    mergeExpiredRouteEvidence(
      candidate,
      addExpiredFallbackAliases(candidate, row),
      'backfill-expired-from-history/compact-history',
      { onLegacyRouteCapRefusal: () => { routeCapRefused = true; } },
    );
    mergeSourceIdentityHistory(candidate, row);
    const candidateRoutes = emittedRouteKeys(candidate);
    const candidateIdentities = archiveRecordSourceIdentities(candidate);
    const preservesEvidence = !routeCapRefused
      && [...olderRoutes].every((route) => candidateRoutes.has(route))
      && [...archiveRecordSourceIdentities(row)].every((identity) => candidateIdentities.has(identity));
    if (!preservesEvidence) {
      createOwner(row);
      continue;
    }

    indexOwner(owner, false);
    Object.assign(newer, candidate);
    for (const identity of owner.commonPostingIdentities) {
      if (!rowProof.has(identity)) owner.commonPostingIdentities.delete(identity);
    }
    if (rowDeclared.size > 0) {
      if (!owner.hasDeclaredIdentities) {
        owner.commonDeclaredIdentities = new Set(rowDeclared);
        owner.hasDeclaredIdentities = true;
      } else {
        for (const identity of owner.commonDeclaredIdentities) {
          if (!rowDeclared.has(identity)) owner.commonDeclaredIdentities.delete(identity);
        }
      }
    }
    indexOwner(owner, true);
  }
  return owners.map(({ representative }) => representative);
}

/**
 * The emitted job URL includes its locale-specific canton section. Comparing
 * only `locale:slug` confuses two valid routes that share a slug in different
 * cantons. Active bridge aliases use the active row's canton; archived aliases
 * retain their recorded route canton where available.
 */
function emittedRouteKey(locale, slug, canton) {
  const section = resolveCantonSection(locale, canton);
  const prefix = locale === 'it' ? '' : `${locale}/`;
  return `${prefix}${section}/${slug}/`;
}

function emittedRouteEntries(job, { active = false } = {}) {
  const defaultCanton = resolveJobCanton(job || {});
  const routeKeys = new Set(localeRouteKeys(job || {}));
  if (active) {
    for (const locale of ACTIVE_JOB_PAGE_LOCALES) {
      const slug = localizedActiveJobSlug(job || {}, locale);
      if (slug) routeKeys.add(`${locale}:${slug}`);
    }
  } else {
    // The expired renderer uses the primary slug when a locale has no
    // explicit localized slug. Keep these paths alongside locale aliases.
    for (const locale of ACTIVE_JOB_PAGE_LOCALES) {
      const slug = job?.slugByLocale?.[locale] || job?.slug;
      if (slug) routeKeys.add(`${locale}:${slug}`);
    }
  }
  const entries = [];
  for (const routeKey of routeKeys) {
    const separator = routeKey.indexOf(':');
    if (separator < 0) continue;
    const locale = routeKey.slice(0, separator);
    const slug = routeKey.slice(separator + 1);
    if (!locale || !slug) continue;
    const routeCanton = active
      ? defaultCanton
      : resolveExpiredRouteCanton(job, locale, slug) || defaultCanton;
    entries.push({
      locale,
      slug,
      canton: routeCanton,
      localeSlugKey: routeKey,
      emittedPath: emittedRouteKey(locale, slug, routeCanton),
    });
  }
  return entries;
}

function emittedRouteKeys(job, options = {}) {
  return new Set(emittedRouteEntries(job, options).map(({ emittedPath }) => emittedPath));
}

function suppressExpiredRoute(entry, { locale, slug }) {
  if (!entry || !locale || !slug || slug === entry.slug) return false;
  const canonicalSlug = entry.slugByLocale?.[locale] || entry.slug;
  const replacement = canonicalSlug === slug ? entry.slug : canonicalSlug;
  if (!replacement || replacement === slug) return false;
  return replaceSlugRouteEverywhere(entry, slug, replacement, {
    source: 'backfill-expired-from-history/same-posting-active-route',
    reason: 'same posting route remains served by its active page',
    locale,
    cap: DEFAULT_PREV_SLUG_CAP,
  }) > 0;
}

function addExpiredFallbackAliases(survivor, historical) {
  const routeEvidence = structuredClone(historical || {});
  const routesByLocale = {};
  const cantonsByLocale = {};
  const survivorRoutes = emittedRouteKeys(survivor);
  for (const locale of ACTIVE_JOB_PAGE_LOCALES) {
    if (historical?.slugByLocale?.[locale]) continue;
    const slug = historical?.slug;
    if (!slug) continue;
    const historicalCanton = resolveExpiredRouteCanton(historical, locale, slug)
      || resolveJobCanton(historical || {});
    const historicalPath = emittedRouteKey(locale, slug, historicalCanton);
    if (survivorRoutes.has(historicalPath)) continue;
    const survivorSlug = survivor?.slugByLocale?.[locale] || survivor?.slug;
    // A locale bucket cannot store two canton-qualified paths for one slug.
    if (slug === survivorSlug) continue;
    (routesByLocale[locale] ||= []).push(slug);
    if (historicalCanton) (cantonsByLocale[locale] ||= {})[slug] = historicalCanton;
  }
  mergeExpiredRouteEvidence(
    routeEvidence,
    { previousSlugsByLocale: routesByLocale, previousSlugCantonByLocale: cantonsByLocale },
    'backfill-expired-from-history/expired-fallback-routes',
  );
  return routeEvidence;
}

function sharesProvenPostingIdentity(left, right, isAmbiguousIdentity = () => false) {
  const leftIdentities = archiveRecordSourceIdentities(left || {});
  const rightIdentities = archiveRecordSourceIdentities(right || {});
  const sharedSpecificIdentity = [...leftIdentities].some((identity) => (
    rightIdentities.has(identity)
    && namesOnePosting(identity)
    && !isAmbiguousIdentity(identity)
  ));
  return sharedSpecificIdentity && archiveRecordNamesPosting(left || {}, right || {});
}

function declaredPostingIdentities(job) {
  return new Set([
    job?.sourceIdentity,
    ...(Array.isArray(job?.sourceIdentityHistory)
      ? job.sourceIdentityHistory.map((entry) => entry?.sourceIdentity)
      : []),
  ].filter((identity) => typeof identity === 'string' && identity.trim()));
}

/**
 * A shared identity token is a sufficient proof for every pair in a group.
 * If there is no token shared by the whole group, retain the owners separately
 * and refuse their route overlap; pairwise links through different tokens are
 * not transitive evidence that all rows describe one posting.
 */
function ownersShareOneProvenPosting(jobs, isAmbiguousIdentity) {
  const uniqueJobs = [...new Set(jobs)];
  if (uniqueJobs.length <= 1) return true;
  let commonPostingIdentities = null;
  let commonDeclaredIdentities = null;
  let hasDeclaredIdentities = false;
  for (const job of uniqueJobs) {
    const postingIdentities = new Set([...archiveRecordSourceIdentities(job)].filter((identity) => (
      namesOnePosting(identity) && !isAmbiguousIdentity(identity)
    )));
    if (commonPostingIdentities === null) commonPostingIdentities = postingIdentities;
    else {
      for (const identity of commonPostingIdentities) {
        if (!postingIdentities.has(identity)) commonPostingIdentities.delete(identity);
      }
    }
    if (commonPostingIdentities.size === 0) return false;

    const declared = declaredPostingIdentities(job);
    if (declared.size > 0) {
      if (!hasDeclaredIdentities) {
        commonDeclaredIdentities = declared;
        hasDeclaredIdentities = true;
      } else {
        for (const identity of commonDeclaredIdentities) {
          if (!declared.has(identity)) commonDeclaredIdentities.delete(identity);
        }
        if (commonDeclaredIdentities.size === 0) return false;
      }
    }
  }
  return true;
}

function hasUnprovenCrossOwnerPair(leftOwners, rightOwners, isAmbiguousIdentity) {
  const leftJobs = [...new Set(leftOwners.map(({ job }) => job))];
  const rightJobs = [...new Set(rightOwners.map(({ job }) => job))];
  if (leftJobs.length === 0 || rightJobs.length === 0) return false;
  if (leftJobs.length === 1) {
    const [single] = leftJobs;
    const manySide = rightJobs.filter((job) => job !== single);
    if (manySide.length === 0) return false;
    return manySide.some((job) => !sharesProvenPostingIdentity(single, job, isAmbiguousIdentity));
  }
  if (rightJobs.length === 1) {
    const [single] = rightJobs;
    const manySide = leftJobs.filter((job) => job !== single);
    if (manySide.length === 0) return false;
    return manySide.some((job) => !sharesProvenPostingIdentity(single, job, isAmbiguousIdentity));
  }
  return !ownersShareOneProvenPosting([...leftJobs, ...rightJobs], isAmbiguousIdentity);
}

function uniqueRouteOwners(owners) {
  const seen = new Set();
  return owners.filter(({ job }) => {
    if (seen.has(job)) return false;
    seen.add(job);
    return true;
  });
}

function parseSlice(blob) {
  try {
    return JSON.parse(blob);
  } catch {
    return null;
  }
}

function buildExpiredEntry(job) {
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
    expiredAt: pickExpiredAt(job),
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
    previousSlugCantonByLocale:
      job.previousSlugCantonByLocale &&
      typeof job.previousSlugCantonByLocale === 'object' &&
      Object.keys(job.previousSlugCantonByLocale).length > 0
        ? JSON.parse(JSON.stringify(job.previousSlugCantonByLocale))
        : undefined,
    postalCode: job.postalCode || '',
    streetAddress: job.streetAddress || '',
    salaryMin: job.salaryMin || null,
    salaryMax: job.salaryMax || null,
    salaryCurrency: job.salaryCurrency || job.currency || 'CHF',
    salaryPeriod: job.salaryPeriod || 'YEAR',
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
  if (sourceIdentity) entry.sourceIdentity = sourceIdentity;
  if (job.firstSeenAt) entry.firstSeenAt = job.firstSeenAt;
  if (!entry.sourceIdentityHistory) delete entry.sourceIdentityHistory;
  return entry;
}

/**
 * Posting identity for a historical row that has no `id`. Use only a URL or
 * declared identity that names one posting; a shared listing URL falls back
 * to route-only slug evidence. A generated title/company fallback is not
 * enough evidence to decide that an old route belongs to one posting.
 */
function idlessPureValues(job) {
  const identities = archiveRecordSourceIdentities(job);
  const slug = String(job?.slug || job?.slugByLocale?.it || '').trim();
  return {
    identities,
    declared: String(job?.sourceIdentity || '').trim(),
    stableJobIdentity: buildStableJobIdentity(job || {}),
    postingIdentities: [...identities].filter((identity) => namesOnePostingMemo(identity)),
    nonPostingIdentities: [...identities].filter((identity) => !namesOnePostingMemo(identity)),
    slugIdentity: slug ? buildStableJobIdentity({ slug }) : '',
  };
}

function idlessBackfillIdentity(job, listingIdentities, pure = idlessPureValues(job)) {
  const {
    identities,
    declared,
    stableJobIdentity,
    postingIdentities,
    nonPostingIdentities,
    slugIdentity,
  } = pure;
  const usableSourceIdentities = postingIdentities.filter((candidate) => (
    !listingIdentities.isAmbiguous(candidate)
  ));
  const ambiguousListingIdentities = nonPostingIdentities.filter((candidate) => (
    listingIdentities.isAmbiguous(candidate)
  ));
  const declaredIsUsable = declared
    && namesOnePostingMemo(declared)
    && !listingIdentities.isAmbiguous(declared);
  const stableIsUsable = /^(?:url|id):/u.test(stableJobIdentity)
    && namesOnePostingMemo(stableJobIdentity)
    && !listingIdentities.isAmbiguous(stableJobIdentity);
  const identity = (declaredIsUsable ? declared : '')
    || (stableIsUsable ? stableJobIdentity : '')
    || (usableSourceIdentities.length === 1 ? usableSourceIdentities[0] : '');

  if (identity) {
    return {
      identity,
      sourceIdentities: usableSourceIdentities,
      ambiguousSourceIdentities: postingIdentities.filter((candidate) => (
        listingIdentities.isAmbiguous(candidate)
      )),
      routeOnly: false,
    };
  }

  // A listing URL is not a posting identity. Keep its demonstrated route
  // under the shared slug fallback, without carrying or matching that URL as
  // source provenance. A truly ambiguous posting identity remains unknown.
  if (ambiguousListingIdentities.length > 0) return null;
  if (postingIdentities.length > 0) return null;
  if (!slugIdentity.startsWith('slug:')) return null;

  return {
    identity: slugIdentity,
    sourceIdentities: [],
    ambiguousSourceIdentities: [],
    listingIdentities: [...nonPostingIdentities],
    routeOnly: identities.size > 0,
  };
}

/**
 * Pick an expiredAt timestamp from job metadata. Prefer the most recent
 * timestamp we have (crawledAt is when we last saw it alive — close enough
 * to "expired right after" without lying about the actual upstream removal
 * time, which we don't have for historical jobs).
 */
function pickExpiredAt(job) {
  const ca = job.crawledAt && !Number.isNaN(new Date(job.crawledAt).getTime()) ? job.crawledAt : null;
  const dp = job.datePosted && !Number.isNaN(new Date(job.datePosted).getTime()) ? job.datePosted : null;
  return ca || dp || new Date().toISOString();
}

// Non escludeva nulla oltre l'estensione: stesso difetto di
// repair-job-locales.mjs. Il filtro `onlyKeys` resta suo, il predicato no.
function listSliceFiles() {
  return listSliceFileNames(BY_CRAWLER_DIR)
    .filter((f) => (onlyKeys.size === 0 ? true : onlyKeys.has(path.basename(f, '.json'))));
}

function listHistoryCommits(relPath, cwd, maxCommits = MAX_COMMITS) {
  let output;
  try {
    output = git(
      ['log', '--all', '--follow', ...historySinceArgs(), '--format=%ct %H', '--', relPath],
      { quiet: true, cwd },
    );
  } catch {
    throw new Error(`Unable to read Git history for ${relPath}`);
  }
  const commits = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [timestamp, sha] = line.split(/\s+/);
      return { sha, timestamp: Number(timestamp) || 0 };
    })
    .filter(({ sha }) => sha);
  return maxCommits > 0 ? commits.slice(0, maxCommits) : commits;
}

/**
 * Read a path from one commit without treating every `git show` failure as an
 * absent path. `ls-tree` proves absence only with a successful empty result;
 * once the tree names the blob, `cat-file` must be able to read that object.
 */
/**
 * Blob OIDs of `relPaths` at commit `sha`, from ONE `git ls-tree`. A missing
 * path maps to null; a path that is not a regular blob is an error, as before.
 * Comparing OIDs tells whether a path changed between two commits without
 * reading or parsing it (a 90 MB archive is identical across most commits).
 */
function resolveHistoricalOids(sha, relPaths, cwd) {
  let listing;
  try {
    listing = git([
      'ls-tree', '-z', '--full-tree', sha, '--', ...relPaths.map((relPath) => `:(literal)${relPath}`),
    ], { quiet: true, cwd });
  } catch {
    throw new Error(`Unable to inspect historical archive paths at ${sha}`);
  }
  const found = new Map();
  for (const raw of listing.split('\0').filter(Boolean)) {
    const separator = raw.indexOf('\t');
    if (separator < 0) continue;
    const [mode, type, oid] = raw.slice(0, separator).split(' ');
    found.set(raw.slice(separator + 1), { mode, type, oid });
  }
  const oids = new Map();
  for (const relPath of relPaths) {
    const entry = found.get(relPath);
    if (!entry) {
      oids.set(relPath, null);
      continue;
    }
    if (entry.type !== 'blob' || !entry.oid) {
      throw new Error(`Historical archive path is not a readable file: ${relPath}`);
    }
    oids.set(relPath, entry.oid);
  }
  return oids;
}

function readHistoricalBlobByOid(oid, relPath, cwd) {
  try {
    return git(['cat-file', 'blob', oid], { quiet: true, cwd });
  } catch {
    throw new Error(`Historical archive path exists but is unreadable: ${relPath}`);
  }
}

function listHistoricalExpiredRelPaths(crawlerKey, cwd, currentFiles = []) {
  const archiveDir = 'data/jobs/expired/by-crawler';
  const monolithPath = `${archiveDir}/${crawlerKey}.json`;
  const shardPathspec = `${archiveDir}/${crawlerKey}.shard-*.json`;
  const changedPaths = git([
    'log', '--all', '--no-renames', '--name-only', '--format=',
    ...historySinceArgs(), '--', monolithPath, shardPathspec,
  ], { quiet: true, cwd });
  const names = new Set([`${crawlerKey}.json`, ...currentFiles]);
  for (const changedPath of changedPaths.split('\n')) {
    const name = path.basename(changedPath.trim());
    if (parseExpiredSliceFileName(name)?.key === crawlerKey) names.add(name);
  }
  return [...names]
    .map((name) => ({ name, index: parseExpiredSliceFileName(name)?.index ?? -1 }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name))
    .map(({ name }) => `${archiveDir}/${name}`);
}

function expiredPrimaryMergeScopeKey(job) {
  const primaryItalianSlug = job?.slugByLocale?.it || job?.slug;
  return job?.companyKey && primaryItalianSlug
    ? `${job.companyKey}::it:${primaryItalianSlug}`
    : '';
}

function sameArchiveCompanyNamespace(left, right) {
  return String(left?.companyKey || '') === String(right?.companyKey || '');
}

/**
 * Whether a `url:` source identity carries a posting-specific token in its last
 * path segment or its query. A token only in an ancestor segment names a board
 * or a tenant. Identities that are not URLs are declared per posting.
 */
function namesOnePosting(identity) {
  if (!identity.startsWith('url:')) return true;
  const url = identity.slice(4).toLowerCase().replace(/\/+$/, '');
  const key = mergeUrlKey(url);
  // `url:` = no token; `req:<host>:num:…` = the vendor rules' tenant fallback.
  if (key.startsWith('url:') || /:(?:num|hex|url):/.test(key)) return false;
  if (key.startsWith('req:')) return true;
  const token = key.slice(key.indexOf(':') + 1);
  const [beforeQuery, ...query] = url.split('#')[0].split('?');
  return `${beforeQuery.split('/').pop()}?${query.join('?')}`.includes(token);
}

/**
 * Collect the identities that name a page, not a posting (a listing URL). Such
 * an identity never proves on its own that a recovered payload is already
 * archived. Three signals:
 *   - two postings under it in one version of the slice;
 *   - two `#fragment`s under it over history;
 *   - for a URL without a posting token, sightings anywhere in history or in the
 *     archive that no chain of shared ids or slugs connects: successive
 *     postings of a one-vacancy listing are never open in the same version.
 * A URL that names one posting needs no link, so a rename that also changes the
 * id is still recognised.
 */
export function createListingIdentityCollector() {
  const ambiguous = new Set();
  const fragmentByIdentity = new Map();
  const groupsByIdentity = new Map(); // identity -> disjoint-set component index
  const seenSightings = new Set();

  const find = (components, item) => {
    let root = item;
    while (components.parent[root] !== root) root = components.parent[root];
    while (components.parent[item] !== item) {
      const next = components.parent[item];
      components.parent[item] = root;
      item = next;
    }
    return root;
  };

  const union = (components, left, right) => {
    let leftRoot = find(components, left);
    let rightRoot = find(components, right);
    if (leftRoot === rightRoot) return;
    if (components.rank[leftRoot] < components.rank[rightRoot]) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    components.parent[rightRoot] = leftRoot;
    if (components.rank[leftRoot] === components.rank[rightRoot]) components.rank[leftRoot] += 1;
  };

  const sightingKeys = (record) => {
    const slugs = [
      record.slug,
      ...Object.values(record.slugByLocale || {}),
      ...(record.previousSlugs || []),
      ...Object.values(record.previousSlugsByLocale || {}).flat(),
    ].filter(Boolean);
    return [...new Set([
      ...(record.id ? [`id:${record.id}`] : []),
      ...slugs.map((slug) => `slug:${slug}`),
    ])];
  };

  const addSighting = (identity, record) => {
    if (!identity || namesOnePostingMemo(identity)) return;
    addSightingKeys(identity, sightingKeys(record));
  };

  const addSightingKeys = (identity, keys) => {
    if (keys.length === 0) return;
    // Most versions repeat the previous one.
    const signature = JSON.stringify([identity, keys]);
    if (seenSightings.has(signature)) return;
    seenSightings.add(signature);
    let components = groupsByIdentity.get(identity);
    if (!components) {
      components = {
        parent: [],
        rank: [],
        nodeByKey: new Map(),
        componentCount: 0,
      };
      groupsByIdentity.set(identity, components);
    }
    const existingRoots = new Set();
    const nodes = [];
    for (const key of keys) {
      let node = components.nodeByKey.get(key);
      if (node === undefined) {
        node = components.parent.length;
        components.parent.push(node);
        components.rank.push(0);
        components.nodeByKey.set(key, node);
        nodes.push(node);
      } else {
        existingRoots.add(find(components, node));
      }
    }
    const touched = [...existingRoots, ...nodes];
    if (existingRoots.size === 0) components.componentCount += 1;
    else components.componentCount -= existingRoots.size - 1;
    for (let index = 1; index < touched.length; index += 1) {
      union(components, touched[0], touched[index]);
    }
  };

  return {
    isAmbiguous: (identity) => ambiguous.has(identity)
      || (groupsByIdentity.get(identity)?.componentCount || 0) > 1,
    addArchiveRow(row) {
      const derived = derivedForEntry(row, { reuseLastAdded: true });
      if (!derived.listing) {
        const identities = [...archiveRecordSourceIdentities(row)].filter((identity) => (
          identity && !namesOnePostingMemo(identity)
        ));
        derived.listing = { identities, keys: identities.length > 0 ? sightingKeys(row || {}) : [] };
      }
      const { identities, keys } = derived.listing;
      if (keys.length === 0) return;
      for (const identity of identities) addSightingKeys(identity, keys);
    },
    addVersion(jobs) {
      for (const identity of ambiguousJobIdentities(jobs)) ambiguous.add(identity);
      for (const job of jobs) {
        // The record built from this job also declares its identity history, and
        // the index matches on it. Sightings only: the job's own `#fragment`
        // says nothing about those older identities.
        for (const identity of archiveRecordSourceIdentities(job)) addSighting(identity, job);
        const url = String(job?.url || '');
        const hashAt = url.indexOf('#');
        const fragment = hashAt < 0 ? null : url.slice(hashAt);
        for (const identity of new Set([job?.sourceIdentity, buildStableJobIdentity(job || {})])) {
          if (!identity) continue;
          addSighting(identity, job || {});
          if (fragment === null) continue;
          const seen = fragmentByIdentity.get(identity);
          if (seen === undefined) fragmentByIdentity.set(identity, fragment);
          else if (seen !== fragment) ambiguous.add(identity);
        }
      }
    },
  };
}

/**
 * Backfill one crawler's expired archive. The directories are parameters so a
 * test can run the real history walk inside a throwaway git repository.
 */

/**
 * Route-set evidence for the dry-run report: every `locale:slug` key served by
 * a job, mapped to the owners that serve it. Pure; used only when a caller asks
 * `processSlice` for a `report`.
 */
function routeOwnerSnapshot(jobs, owners = new Map()) {
  for (const job of jobs) {
    const owner = String(job?.id || job?.slug || '');
    for (const routeKey of localeRouteKeys(job || {})) {
      if (!owners.has(routeKey)) owners.set(routeKey, new Set());
      owners.get(routeKey).add(owner);
    }
  }
  return owners;
}

function routeLocale(routeKey) {
  return routeKey.slice(0, routeKey.indexOf(':'));
}

/** Compare two snapshots: routes lost, owners changed, routes restored by locale. */
export function compareRouteSnapshots(before, after) {
  const lost = [];
  const ownerChanged = [];
  const restoredByLocale = {};
  for (const [routeKey, beforeOwners] of before) {
    const afterOwners = after.get(routeKey);
    if (!afterOwners) {
      lost.push(routeKey);
      continue;
    }
    if (![...beforeOwners].every((owner) => afterOwners.has(owner))) ownerChanged.push(routeKey);
  }
  for (const routeKey of after.keys()) {
    if (before.has(routeKey)) continue;
    const locale = routeLocale(routeKey);
    restoredByLocale[locale] = (restoredByLocale[locale] || 0) + 1;
  }
  return { lost, ownerChanged, restoredByLocale };
}

export function processSlice(sliceFile, {
  rootDir = ROOT,
  byCrawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler'),
  expiredDir = path.join(rootDir, 'data', 'jobs', 'expired', 'by-crawler'),
  maxCommits = MAX_COMMITS,
  stagingDir = null,
  dryRun = DRY_RUN,
  report = null,
  // Skip reading/parsing/walking a path whose blob OID equals the one just
  // processed. Off only to prove equivalence in tests.
  dedupHistoricalBlobs = true,
  // Separate switch for the entry-level skip; BACKFILL_DEDUP_ENTRIES=0 turns it
  // off in a dry run to compare reports on real data.
  dedupExpiredEntries = process.env.BACKFILL_DEDUP_ENTRIES !== '0',
} = {}) {
  const walkStats = { activeWalkMs: 0, expiredWalkMs: 0, distinctOids: {}, parses: {} };
  const noteOid = (relPath, oid) => {
    (walkStats.distinctOids[relPath] ||= new Set()).add(oid);
  };
  const noteParse = (relPath) => {
    walkStats.parses[relPath] = (walkStats.parses[relPath] || 0) + 1;
  };
  const crawlerKey = path.basename(sliceFile, '.json');
  const phaseStartedAt = performance.now();
  // Opt-in progress lines (BACKFILL_PHASE_LOG=1) so a run that is killed by a
  // timeout still shows which phase was slow.
  const phase = (name) => {
    if (process.env.BACKFILL_PHASE_LOG !== '1') return;
    const seconds = Math.round((performance.now() - phaseStartedAt) / 1000);
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.error(`[phase] ${crawlerKey} ${name} +${seconds}s rss=${rssMb}MB`);
  };
  const currentRel = `data/jobs/by-crawler/${sliceFile}`;
  // The archive is the monolith plus its `<key>.shard-NNN.json` files
  // (scripts/lib/expired-slice-store.mjs). Include paths found in Git history,
  // not only files still present in this checkout: deleted and compacted
  // shards can be the only remaining owners of an indexed route.
  phase('start');
  const currentExpiredFiles = listExpiredSliceFiles(crawlerKey, { dir: expiredDir })
    .map((file) => file.name);
  const expiredRels = listHistoricalExpiredRelPaths(crawlerKey, rootDir, currentExpiredFiles);
  const currentPath = path.join(byCrawlerDir, sliceFile);
  if (!fs.existsSync(currentPath)) return null;

  phase('expired paths listed');
  const currentBlob = fs.readFileSync(currentPath, 'utf-8');
  const currentPayload = parseSlice(currentBlob);
  const currentJobs = readJobsFromSlice(currentBlob);
  // Snapshot before any in-place enrichment: the dry-run report compares it
  // with the routes the written (or staged) output would serve.
  const activeSnapshotBefore = report ? routeOwnerSnapshot(currentJobs) : null;
  const currentIds = new Set(currentJobs.map((j) => j.id).filter(Boolean));
  const currentSlugs = new Set(currentJobs.map((j) => j.slug).filter(Boolean));
  const currentSourceIdentities = new Set(currentJobs.flatMap((job) => (
    [...archiveRecordSourceIdentities(job)]
  )));
  const currentOwnersBySpecificSourceIdentity = new Map();
  const currentRouteOwners = new Map();
  for (const job of currentJobs) {
    for (const identity of archiveRecordSourceIdentities(job)) {
      if (!namesOnePosting(identity)) continue;
      const owners = currentOwnersBySpecificSourceIdentity.get(identity) || new Set();
      owners.add(job);
      currentOwnersBySpecificSourceIdentity.set(identity, owners);
    }
    for (const routeKey of emittedRouteKeys(job, { active: true })) {
      const owners = currentRouteOwners.get(routeKey) || new Set();
      owners.add(job);
      currentRouteOwners.set(routeKey, owners);
    }
  }
  const currentSlugIdentities = new Set(currentJobs.flatMap((job) => {
    const localizedSlugs = job?.slugByLocale && typeof job.slugByLocale === 'object'
      ? Object.values(job.slugByLocale)
      : [];
    return [job?.slug, ...localizedSlugs]
      .filter((slug) => typeof slug === 'string' && slug.trim())
      .map((slug) => buildStableJobIdentity({ slug }));
  }));
  const currentRouteKeys = new Set(currentJobs.flatMap((job) => [...emittedRouteKeys(job, { active: true })]));

  // Walk commits that touched this file. --follow handles renames; the
  // tradeoff is git ignores merge commits' textual diff, which is fine —
  // squash-merged commits still show, and we cover them via the per-commit
  // blob read below.
  // --all is required here: the 2026-05-27 history rewrite (PR #645)
  // stranded the pre-rewrite branch tips. Those reachable-only-via-reflog
  // commits hold the very job data we're trying to recover — without
  // --all the walk only sees the ~5 post-rewrite commits. The expired path is
  // included as well: later housekeeping can collapse or remove an archive
  // entry even though its source posting remains recoverable in Git.
  phase('current slice parsed; listing history commits');
  const commitBySha = new Map();
  for (const commit of [
    ...listHistoryCommits(currentRel, rootDir, maxCommits),
    ...expiredRels.flatMap((expiredRel) => listHistoryCommits(expiredRel, rootDir, maxCommits)),
  ]) {
    const prior = commitBySha.get(commit.sha);
    if (!prior || commit.timestamp > prior.timestamp) commitBySha.set(commit.sha, commit);
  }
  const commits = [...commitBySha.values()]
    .sort((a, b) => b.timestamp - a.timestamp || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0))
    .map(({ sha }) => sha);
  if (commits.length === 0) return null;
  const sliceCommits = commits;
  phase(`history listed (${sliceCommits.length} commits)`);

  // Walk commits NEWEST → OLDEST (git log default order). First time we see
  // a lost id wins — that's the most recent version of the job. The compact
  // metadata index sees every historical version, including jobs that are
  // active today, so legacy archive entries can recover firstSeenAt too.
  const lostById = new Map();
  const lostByStableIdentity = new Map();
  const activeRouteEvidenceByKey = new Map();
  const routeOnlyCandidates = new WeakSet();
  const routeOnlyListingIdentities = new WeakMap();
  const unresolvedIdlessRouteKeys = new Set();
  const unresolvedIdlessRouteReasons = new Map();
  const historicalSnapshotRoutesByStableIdentity = new Map();
  // Ids whose most recent historical version was held out of publication for
  // translation: never public, so never archived (no expired soft-landing).
  const heldLostIds = new Set();
  const heldLostStableIdentities = new Set();
  const historicalExpiredOwners = createHistoricalExpiredOwnerCollector();
  const historicalActiveOwners = new Map();
  const historicalExpiredRoutePaths = new Set();
  const historicalActiveRoutePaths = new Set();
  const historicalIndex = createFirstSeenMetadataIndex();
  const listingIdentities = createListingIdentityCollector();
  listingIdentities.addVersion(currentJobs);
  const noteUncoveredRouteKeys = (routeKeys, coveredRoutes, reason = '') => {
    for (const routeKey of routeKeys) {
      if (coveredRoutes.has(routeKey)) continue;
      unresolvedIdlessRouteKeys.add(routeKey);
      if (reason) unresolvedIdlessRouteReasons.set(routeKey, reason);
    }
  };
  const noteUncoveredIdlessRoutes = (
    job,
    coveredRoutes = currentRouteKeys,
    routeKeys = emittedRouteKeys(job, { active: true }),
  ) => {
    noteUncoveredRouteKeys(routeKeys, coveredRoutes);
  };
  const refuseIdlessRoutes = (job, reason, routeKeys = emittedRouteKeys(job, { active: true })) => {
    for (const routeKey of routeKeys) {
      if (currentRouteKeys.has(routeKey)) continue;
      unresolvedIdlessRouteKeys.add(routeKey);
      unresolvedIdlessRouteReasons.set(routeKey, reason);
    }
  };
  let previousActiveOid = null;
  // Parsed jobs of the last active blob and how many consecutive commits
  // carried it. The first two sightings run the full per-job loop (the second
  // can add refusals the first cannot, via the merge branch); from the third
  // on the loop is a no-op by construction (sets and first-wins maps only).
  let activeRun = null;
  const previousExpiredOids = new Map();
  const seenExpiredEntries = new Set();
  let walked = 0;
  for (const sha of sliceCommits) {
    if (walked % 10 === 0) {
      phase(`walk ${walked}/${sliceCommits.length} activeMs=${Math.round(walkStats.activeWalkMs)} expiredMs=${Math.round(walkStats.expiredWalkMs)}`);
    }
    walked += 1;
    const oids = resolveHistoricalOids(sha, [currentRel, ...expiredRels], rootDir);
    const activeStartedAt = performance.now();
    const activeOid = oids.get(currentRel);
    if (activeOid != null) {
      noteOid(currentRel, activeOid);
      let jobs;
      let skipActiveLoop = false;
      if (dedupHistoricalBlobs && activeRun?.oid === activeOid) {
        activeRun.count += 1;
        skipActiveLoop = activeRun.count >= 3;
        jobs = activeRun.jobs;
      } else {
        const blob = readHistoricalBlobByOid(activeOid, currentRel, rootDir);
        noteParse(currentRel);
        jobs = readHistoricalJobs(blob, currentRel, sha, 'active crawler slice');
        activeRun = { oid: activeOid, jobs, count: 1 };
      }
      // Most commits touch only the archive: do not re-scan an unchanged slice.
      if (activeOid !== previousActiveOid) listingIdentities.addVersion(jobs);
      previousActiveOid = activeOid;
      if (!skipActiveLoop) for (const job of jobs) {
        const derived = activeDerivedForJob(job);
        const held = derived.held;
        const jobRouteKeys = derived.routeKeys;
        historicalIndex.add(job, derived.firstSeen);
        if (!held) {
          if (derived.routes.length > 0) {
            addActiveHistoricalOwnerSighting(historicalActiveOwners, job, derived);
            for (const emittedPath of derived.routePaths) historicalActiveRoutePaths.add(emittedPath);
          }
        }
        if (!job?.slug) {
          // The active renderer can derive locale routes from title/company/
          // location even when the stored root slug is blank. Do not infer a
          // posting identity from those routes; refuse any uncovered path
          // below unless another exact owner already serves it.
          if (!held) noteUncoveredIdlessRoutes(job, currentRouteKeys, jobRouteKeys);
          continue;
        }
        if (job?.id) {
          if (currentIds.has(job.id)) continue;
          if (currentSlugs.has(job.slug)) continue; // same slug, different id — treat as kept
          if (lostById.has(job.id) || heldLostIds.has(job.id)) continue;
          if (held) {
            heldLostIds.add(job.id);
            continue;
          }
          lostById.set(job.id, job);
          continue;
        }

        derived.idless ||= idlessPureValues(job);
        const stable = idlessBackfillIdentity(job, listingIdentities, derived.idless);
        if (!stable) {
          if (held) {
            const heldIdentity = buildStableJobIdentity(job);
            if (heldIdentity && !heldIdentity.startsWith('fallback:')) {
              heldLostStableIdentities.add(heldIdentity);
            }
            continue;
          }
          const matchingSpecificIdentities = [...derived.idless.identities].filter((identity) => (
            namesOnePostingMemo(identity) && currentSourceIdentities.has(identity)
          ));
          if (matchingSpecificIdentities.length > 0) {
            refuseIdlessRoutes(
              job,
              'source identity or active owner is ambiguous; no route target was selected',
              jobRouteKeys,
            );
            continue;
          }
          noteUncoveredIdlessRoutes(job, currentRouteKeys, jobRouteKeys);
          continue; // unknown identity is refused below if its route would be lost
        }
        if (heldLostStableIdentities.has(stable.identity)) continue;
        if (held) {
          heldLostStableIdentities.add(stable.identity);
          continue;
        }
        if (stable.routeOnly) {
          const jobRoutes = [...jobRouteKeys];
          if (jobRoutes.every((routeKey) => currentRouteKeys.has(routeKey))) continue;
        } else {
          const matchingSourceIdentities = stable.sourceIdentities.filter((identity) => (
            currentSourceIdentities.has(identity)
          ));
          const sourceIdentityAlreadyActive = matchingSourceIdentities.length > 0;
          const jobRoutes = [...jobRouteKeys];
          const matchingActiveOwners = new Set(matchingSourceIdentities.flatMap((identity) => (
            [...(currentOwnersBySpecificSourceIdentity.get(identity) || [])]
          )));
          const everyRouteOwnedByMatchingPosting = jobRoutes.every((routeKey) => {
            const routeOwners = currentRouteOwners.get(routeKey);
            return routeOwners?.size > 0
              && [...routeOwners].every((owner) => matchingActiveOwners.has(owner));
          });
          if (sourceIdentityAlreadyActive
            && everyRouteOwnedByMatchingPosting) continue;
          if (stable.ambiguousSourceIdentities.some((identity) => currentSourceIdentities.has(identity))) {
            refuseIdlessRoutes(
              job,
              'source identity is ambiguous while the posting appears active',
              jobRoutes,
            );
            continue;
          }
          if (sourceIdentityAlreadyActive) {
            if (!derived.evidence) {
              const routePayload = compactActiveRoutePayload(job);
              const ownerEvidence = compactOwnerEvidence(job, { active: true });
              derived.evidence = {
                routePayload,
                ownerEvidence,
                evidenceKey: stableStringify({ ownerEvidence, routePayload }),
              };
            }
            const { routePayload, ownerEvidence, evidenceKey } = derived.evidence;
            const previousEvidence = activeRouteEvidenceByKey.get(evidenceKey);
            if (previousEvidence) {
              for (const identity of matchingSourceIdentities) previousEvidence.matchingSourceIdentities.add(identity);
            } else {
              activeRouteEvidenceByKey.set(evidenceKey, {
                ownerEvidence,
                routePayload,
                routeEntries: derived.routes.map((route) => ({ ...route })),
                matchingSourceIdentities: new Set(matchingSourceIdentities),
              });
            }
            continue;
          }
          if (!sourceIdentityAlreadyActive
            && stable.identity.startsWith('slug:')
            && currentSlugIdentities.has(stable.identity)) continue;
        }

        const snapshotRouteKeys = new Set(jobRouteKeys);
        if (!stable.routeOnly) {
          const historicalSnapshotRoutes = historicalSnapshotRoutesByStableIdentity.get(stable.identity) || new Set();
          for (const routeKey of snapshotRouteKeys) historicalSnapshotRoutes.add(routeKey);
          historicalSnapshotRoutesByStableIdentity.set(stable.identity, historicalSnapshotRoutes);
        }

        const previousCandidate = lostByStableIdentity.get(stable.identity);
        if (previousCandidate) {
          if (stable.routeOnly || routeOnlyCandidates.has(previousCandidate)) {
            const coveredRoutes = new Set([
              ...currentRouteKeys,
              ...emittedRouteKeys(previousCandidate, { active: true }),
            ]);
            noteUncoveredIdlessRoutes(job, coveredRoutes, jobRouteKeys);
            continue;
          }

          let routeCapRefused = false;
          mergeExpiredRouteEvidence(
            previousCandidate,
            addExpiredFallbackAliases(previousCandidate, job),
            `backfill-expired-from-history/${sliceFile}`,
            { onLegacyRouteCapRefusal: () => { routeCapRefused = true; } },
          );
          const coveredRoutes = new Set([
            ...currentRouteKeys,
            ...emittedRouteKeys(previousCandidate),
          ]);
          const historicalSnapshotRoutes = historicalSnapshotRoutesByStableIdentity.get(stable.identity) || snapshotRouteKeys;
          noteUncoveredRouteKeys(
            historicalSnapshotRoutes,
            coveredRoutes,
            routeCapRefused
              ? 'historical routes cannot be represented after archive route-cap refusal'
              : 'historical routes cannot be represented by the merged archive candidate',
          );
          continue;
        }

        const candidate = stable.routeOnly
          ? {
            ...job,
            url: '',
            sourceIdentity: '',
            sourceIdentityHistory: undefined,
          }
          : { ...job, sourceIdentity: stable.identity };
        if (stable.routeOnly) {
          routeOnlyCandidates.add(candidate);
          routeOnlyListingIdentities.set(candidate, stable.listingIdentities);
        }
        lostByStableIdentity.set(stable.identity, candidate);
      }
    }

    walkStats.activeWalkMs += performance.now() - activeStartedAt;

    const expiredStartedAt = performance.now();
    for (const expiredRel of expiredRels) {
      const expiredOid = oids.get(expiredRel);
      if (expiredOid == null) continue;
      noteOid(expiredRel, expiredOid);
      // Same OID as the commit just before: every call below only adds to sets
      // and first-wins maps keyed by the entry content, so re-reading and
      // re-adding the identical archive changes nothing.
      if (dedupHistoricalBlobs && previousExpiredOids.get(expiredRel) === expiredOid) continue;
      previousExpiredOids.set(expiredRel, expiredOid);
      const expiredBlob = readHistoricalBlobByOid(expiredOid, expiredRel, rootDir);
      noteParse(expiredRel);
      for (const entry of readHistoricalJobs(expiredBlob, expiredRel, sha, 'expired archive slice')) {
        // Successive archive versions share almost every entry. An entry
        // byte-identical to one already added is an exact duplicate: the
        // collector and the listing index only add to sets keyed by its
        // content, so re-adding it changes nothing (and costs most of the walk).
        if (dedupHistoricalBlobs && dedupExpiredEntries) {
          const digest = createHash('sha1').update(JSON.stringify(entry)).digest('base64');
          if (seenExpiredEntries.has(digest)) continue;
          seenExpiredEntries.add(digest);
        }
        const owner = historicalExpiredOwners.add(entry);
        for (const { emittedPath } of owner.evidence.routeEntries) historicalExpiredRoutePaths.add(emittedPath);
        listingIdentities.addArchiveRow(entry);
      }
    }
    walkStats.expiredWalkMs += performance.now() - expiredStartedAt;
  }
  phase('walk done');
  const walkFinishedAt = performance.now();
  if (report) {
    report.timings = {
      activeWalkMs: Math.round(walkStats.activeWalkMs),
      expiredWalkMs: Math.round(walkStats.expiredWalkMs),
    };
    report.distinctOids = Object.fromEntries(
      Object.entries(walkStats.distinctOids).map(([relPath, oids]) => [relPath, oids.size]),
    );
    report.parses = { ...walkStats.parses };
  }

  // No early return on an empty lost set: the existing slice still gets its
  // ingress repair below, which is the whole point of reading it.

  // Read all existing expired rows. Recovery indexes by the archive's
  // company-and-primary-route scope, never by a bare slug.
  // Monolith + shards through the store. An unreadable file fails the run:
  // starting fresh would rewrite it with only the recovered rows.
  phase('reading existing archive');
  const existingShards = readExpiredSliceShards(crawlerKey, { dir: expiredDir });
  const existing = existingShards.flatMap((shard) => shard.rows);
  const snapshotBefore = report ? routeOwnerSnapshot(existing, activeSnapshotBefore) : null;
  // Called at every refusal return: records what the refused slice leaves
  // unrecovered (routes of lost postings not served today). Nothing is written.
  const refusalDetails = (reason = '', refusedKeys = []) => {
    if (report) {
      report.refusalReason = reason;
      const sortedRefused = [...refusedKeys].sort();
      report.refusedRouteKeys = sortedRefused.slice(0, 200);
      report.refusedRouteKeysDigest = createHash('sha1').update(sortedRefused.join('\n')).digest('hex');
      const unrestored = new Set();
      for (const job of [...lostById.values(), ...lostByStableIdentity.values()]) {
        for (const routeKey of localeRouteKeys(job || {})) {
          if (!snapshotBefore.has(routeKey)) unrestored.add(routeKey);
        }
      }
      report.timings.collisionChecksMs = Math.round(performance.now() - walkFinishedAt);
      report.refused = true;
      report.unrestoredLegitimateRoutes = unrestored.size;
      report.unrestoredLegitimateRouteKeys = [...unrestored].sort().slice(0, 100);
      report.lost = [];
      report.ownerChanged = [];
      report.restoredByLocale = {};
    }
    return {};
  };

  const archiveEntries = [];
  const archiveEntriesByMergeScope = new Map();
  const archiveEntriesByIdentity = new Map();
  const archiveIdentityKey = (companyKey, identity) => JSON.stringify([
    String(companyKey || ''),
    identity,
  ]);
  const addToSetIndex = (index, key, row) => {
    const rows = index.get(key) || new Set();
    rows.add(row);
    index.set(key, rows);
  };
  const removeFromSetIndex = (index, key, row) => {
    const rows = index.get(key);
    if (!rows) return;
    rows.delete(row);
    if (rows.size === 0) index.delete(key);
  };
  const indexArchiveEntry = (row) => {
    const mergeScope = expiredPrimaryMergeScopeKey(row);
    if (mergeScope) addToSetIndex(archiveEntriesByMergeScope, mergeScope, row);
    for (const identity of archiveRecordSourceIdentities(row)) {
      addToSetIndex(archiveEntriesByIdentity, archiveIdentityKey(row?.companyKey, identity), row);
    }
  };
  const unindexArchiveEntry = (row) => {
    const mergeScope = expiredPrimaryMergeScopeKey(row);
    if (mergeScope) removeFromSetIndex(archiveEntriesByMergeScope, mergeScope, row);
    for (const identity of archiveRecordSourceIdentities(row)) {
      removeFromSetIndex(archiveEntriesByIdentity, archiveIdentityKey(row?.companyKey, identity), row);
    }
  };
  for (const row of existing) {
    archiveEntries.push(row);
    indexArchiveEntry(row);
  }

  const archiveOwnershipOwners = new Map();
  const currentArchivePayloads = new Set(existing.map((row) => payloadFingerprint(row)));
  for (const row of existing) {
    const owner = addHistoricalOwnerSighting(archiveOwnershipOwners, row, { retainPayload: true });
    owner.kinds ||= new Set();
    owner.kinds.add('existing-expired');
    listingIdentities.addArchiveRow(row);
  }
  for (const historicalOwner of historicalExpiredOwners.values()) {
    mergeHistoricalOwnerAccumulator(archiveOwnershipOwners, historicalOwner);
    const owner = archiveOwnershipOwners.get(historicalOwnerAccumulatorKey(
      historicalOwner.identityEvidence,
      historicalOwner.firstPayloadFingerprint,
    ));
    owner.kinds ||= new Set();
    owner.kinds.add('historical-expired');
  }
  const archiveOwnershipRows = [];
  for (const [key, owner] of archiveOwnershipOwners) {
    const kind = owner.kinds?.has('existing-expired') ? 'existing-expired' : 'historical-expired';
    for (const job of expandOwnerEvidence(new Map([[key, owner]]), listingIdentities)) {
      archiveOwnershipRows.push({ job, kind });
    }
  }
  // The full history and archive are now represented. A URL identity can only
  // become ambiguous after a later-discovered listing sibling, so fail closed
  // for candidates collected before that evidence arrived.
  for (const [identity, candidate] of lostByStableIdentity) {
    const candidateSourceIdentities = routeOnlyCandidates.has(candidate)
      ? routeOnlyListingIdentities.get(candidate) || []
      : [...archiveRecordSourceIdentities(candidate)];
    const ambiguousActiveOverlap = candidateSourceIdentities
      .filter((sourceIdentity) => namesOnePosting(sourceIdentity))
      .some((sourceIdentity) => (
        listingIdentities.isAmbiguous(sourceIdentity) && currentSourceIdentities.has(sourceIdentity)
      ));
    const ambiguousListingIdentity = candidateSourceIdentities.some((sourceIdentity) => (
      !namesOnePosting(sourceIdentity) && listingIdentities.isAmbiguous(sourceIdentity)
    ));
    if (listingIdentities.isAmbiguous(identity) || ambiguousActiveOverlap || ambiguousListingIdentity) {
      noteUncoveredIdlessRoutes(candidate);
      lostByStableIdentity.delete(identity);
    }
  }

  // Snapshot exact emitted-path ownership before route transfer, recovery, or
  // archive collapse can mutate any row. Active rows use the production slug
  // fallback; archive rows use the expired renderer's route-canton map.
  const routeOwnersByEmittedPath = new Map();
  const archiveMergeScopeGroups = new Map();
  const archiveExactPathGroups = new Map();
  const addRouteOwnerToGroup = (groups, key, owner) => {
    let group = groups.get(key);
    if (!group) {
      group = { owners: [], proofKeys: new Set() };
      groups.set(key, group);
    }
    if (owner.proofKey && group.proofKeys.has(owner.proofKey)) return;
    if (owner.proofKey) group.proofKeys.add(owner.proofKey);
    group.owners.push(owner);
  };
  const routeOwnersAtPath = (routeKey) => routeOwnersByEmittedPath.get(routeKey)?.owners || [];
  const activePageOwnersAtPath = (routeKey) => {
    const owners = new Set(currentRouteOwners.get(routeKey) || []);
    for (const owner of routeOwnersAtPath(routeKey)) {
      if (owner.kind === 'planned-active-alias') owners.add(owner.job);
    }
    return [...owners];
  };
  const indexRouteOwners = (
    row,
    kind,
    { active = false, archiveParticipant = false, pathOwner = true } = {},
  ) => {
    const job = Array.isArray(row?.routeEntries) ? row : compactOwnerEvidence(row, { active });
    for (const route of job.routeEntries) {
      const owner = {
        ...route,
        job,
        kind,
        proofKey: routeOwnerProofKey(job, kind, route, listingIdentities.isAmbiguous),
      };
      if (pathOwner) {
        addRouteOwnerToGroup(routeOwnersByEmittedPath, route.emittedPath, owner);
      }
      if (!archiveParticipant) continue;
      addRouteOwnerToGroup(archiveExactPathGroups, route.emittedPath, owner);
      if (!job?.companyKey) continue; // the archive writer never merges unnamespaced rows
      const mergeScope = `${job.companyKey}::${route.localeSlugKey}`;
      addRouteOwnerToGroup(archiveMergeScopeGroups, mergeScope, owner);
    }
  };
  for (const job of currentJobs) indexRouteOwners(job, 'current-active', { active: true });
  for (const job of expandOwnerEvidence(historicalActiveOwners, listingIdentities)) {
    indexRouteOwners(job, 'historical-active-snapshot', { active: true });
  }
  for (const job of [...lostById.values(), ...lostByStableIdentity.values()]) {
    indexRouteOwners(job, 'historical-active-candidate', {
      active: true,
      archiveParticipant: true,
      // The corresponding historical snapshot already owns these active
      // paths. The candidate participates in archive-collapse checks only.
      pathOwner: false,
    });
  }
  for (const evidence of activeRouteEvidenceByKey.values()) {
    indexRouteOwners(evidence.ownerEvidence, 'active-route-evidence', { active: true });
  }
  for (const { job, kind } of archiveOwnershipRows) {
    indexRouteOwners(job, kind, { archiveParticipant: true });
  }

  // The archive writer merges only within companyKey::locale:slug. A proven
  // same-posting pair still cannot merge if one locale slug emitted two
  // different canton-qualified paths.
  phase('archive ownership checks');
  const refusedArchiveRoutePaths = new Set();
  for (const owner of historicalExpiredOwners.values()) {
    const stillProven = [...owner.commonPostingIdentities].some((identity) => (
      namesOnePosting(identity) && !listingIdentities.isAmbiguous(identity)
    ));
    if (owner.hasDistinctPayload && !stillProven) {
      for (const { emittedPath } of owner.routeEvidenceByPath.values()) {
        refusedArchiveRoutePaths.add(emittedPath);
      }
    }
  }
  for (const { owners } of archiveMergeScopeGroups.values()) {
    const uniqueOwners = uniqueRouteOwners(owners);
    const emittedPaths = new Set(owners.map(({ emittedPath }) => emittedPath));
    if (emittedPaths.size > 1
      || (uniqueOwners.length > 1
        && !ownersShareOneProvenPosting(uniqueOwners.map(({ job }) => job), listingIdentities.isAmbiguous))) {
      for (const emittedPath of emittedPaths) refusedArchiveRoutePaths.add(emittedPath);
    }
  }
  // Company namespaces do not apply to URLs: distinct archive companies may
  // not both claim one exact public path. Missing companyKey also means no
  // writer merge scope exists for colliding rows.
  for (const [emittedPath, { owners }] of archiveExactPathGroups) {
    const uniqueOwners = uniqueRouteOwners(owners);
    const companyNamespaces = new Set(uniqueOwners
      .map(({ job }) => String(job?.companyKey || ''))
      .filter(Boolean));
    const hasUnnamespacedOwner = uniqueOwners.some(({ job }) => !job?.companyKey);
    if (uniqueOwners.length > 1
      && (hasUnnamespacedOwner || companyNamespaces.size > 1)) {
      refusedArchiveRoutePaths.add(emittedPath);
    }
  }
  const activeOwnerKinds = new Set([
    'current-active',
    'historical-active-snapshot',
  ]);
  const expiredOwnerKinds = new Set([
    'existing-expired',
    'historical-expired',
    'historical-active-candidate',
  ]);
  for (const [emittedPath, { owners }] of routeOwnersByEmittedPath) {
    const activeOwners = owners.filter(({ kind }) => activeOwnerKinds.has(kind));
    const expiredOwners = owners.filter(({ kind }) => expiredOwnerKinds.has(kind));
    if (hasUnprovenCrossOwnerPair(activeOwners, expiredOwners, listingIdentities.isAmbiguous)) {
      refusedArchiveRoutePaths.add(emittedPath);
    }
    const currentOwners = owners.filter(({ kind }) => kind === 'current-active');
    const historicalActiveOwners = owners.filter(({ kind }) => kind === 'historical-active-snapshot');
    if (hasUnprovenCrossOwnerPair(currentOwners, historicalActiveOwners, listingIdentities.isAmbiguous)) {
      refusedArchiveRoutePaths.add(emittedPath);
    }
  }
  if (refusedArchiveRoutePaths.size > 0) {
    console.error(
      `::error::backfill-expired-from-history/${sliceFile}: refusing to write the slice; `
      + `${refusedArchiveRoutePaths.size} emitted route(s) have archive ownership or canton history `
      + 'that the archive cannot represent safely',
    );
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostById.size + lostByStableIdentity.size,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: 0,
      refusedRoutes: refusedArchiveRoutePaths.size,
      ...refusalDetails('archive-ownership', [...refusedArchiveRoutePaths]),
    };
  }

  // Source identity evidence proves that an id-less historical row is still
  // active only when every matching specific identity has one active owner.
  // Plan route transfers first so an ambiguous identity or a route already
  // claimed by another active page refuses the whole slice before either file
  // can be written.
  phase('active route merge plans');
  const activeRouteMergePlans = [];
  const recoveredCandidateOwnersByPath = new Map();
  const recoveredCandidates = new Set([
    ...lostById.values(),
    ...lostByStableIdentity.values(),
  ]);
  const recoveredCandidateEntries = new Map();
  const previouslyServedRouteKeys = new Set([
    ...currentRouteKeys,
    ...existing.flatMap((entry) => [...emittedRouteKeys(entry || {})]),
    ...historicalExpiredRoutePaths,
    ...historicalActiveRoutePaths,
  ]);
  for (const candidate of recoveredCandidates) {
    const archiveCandidate = buildExpiredEntry(candidate);
    const activeRouteCanton = resolveJobCanton(candidate || {});
    if (activeRouteCanton) {
      for (const [locale, aliases] of Object.entries(archiveCandidate.previousSlugsByLocale || {})) {
        if (!Array.isArray(aliases)) continue;
        for (const slug of aliases) {
          const recordedCanton = resolveExpiredRouteCanton(archiveCandidate, locale, slug);
          if (!recordedCanton || recordedCanton === activeRouteCanton) continue;
          const recordedPath = emittedRouteKey(locale, slug, recordedCanton);
          // An old path present in the route evidence is historical ownership,
          // not stale metadata. Leave it intact so the final guard can refuse
          // if one alias cannot represent both canton-qualified paths.
          if (previouslyServedRouteKeys.has(recordedPath)) continue;
          setExpiredRouteCanton(archiveCandidate, locale, slug, activeRouteCanton);
        }
      }
    }
    recoveredCandidateEntries.set(candidate, archiveCandidate);
    for (const { emittedPath } of emittedRouteEntries(archiveCandidate)) {
      const owners = recoveredCandidateOwnersByPath.get(emittedPath) || [];
      owners.push(archiveCandidate);
      recoveredCandidateOwnersByPath.set(emittedPath, owners);
    }
  }
  for (const evidence of activeRouteEvidenceByKey.values()) {
    const matchingIdentities = [...new Set(evidence.matchingSourceIdentities)];
    const owners = new Set();
    let ambiguous = matchingIdentities.length === 0;
    for (const identity of matchingIdentities) {
      const identityOwners = currentOwnersBySpecificSourceIdentity.get(identity);
      if (listingIdentities.isAmbiguous(identity) || identityOwners?.size !== 1) {
        ambiguous = true;
      }
      for (const owner of identityOwners || []) owners.add(owner);
    }
    if (ambiguous || owners.size !== 1) {
      refuseIdlessRoutes(
        evidence.ownerEvidence,
        'source identity or active owner is ambiguous; no route target was selected',
        evidence.routeEntries.map(({ emittedPath }) => emittedPath),
      );
      continue;
    }

    const [owner] = owners;
    const ownerCanton = resolveJobCanton(owner || {});
    const historicalRoutes = evidence.routeEntries;
    const ownerRouteKeys = emittedRouteKeys(owner, { active: true });
    const unrepresentableHistoricalRoutes = historicalRoutes.filter(({ emittedPath, locale, slug }) => (
      !ownerRouteKeys.has(emittedPath)
      && emittedPath !== emittedRouteKey(locale, slug, ownerCanton)
    ));
    if (unrepresentableHistoricalRoutes.length > 0) {
      for (const { emittedPath } of unrepresentableHistoricalRoutes) {
        unresolvedIdlessRouteKeys.add(emittedPath);
        unresolvedIdlessRouteReasons.set(
          emittedPath,
          'historical active route cannot be emitted by its current owner without changing its canton-qualified path',
        );
      }
      continue;
    }
    const missingOwnerRoutes = historicalRoutes.map(({ locale, slug }) => (
      emittedRouteKey(
        locale,
        slug,
        ownerCanton,
      )
    )).filter((routeKey) => routeKey && !ownerRouteKeys.has(routeKey));
    const collisions = missingOwnerRoutes.filter((routeKey) => (
      [...(currentRouteOwners.get(routeKey) || [])].some((activeOwner) => activeOwner !== owner)
    ));
    if (collisions.length > 0) {
      for (const routeKey of collisions) {
        unresolvedIdlessRouteKeys.add(routeKey);
        unresolvedIdlessRouteReasons.set(
          routeKey,
          'historical route collides with another active route; no active owner was changed',
        );
      }
      continue;
    }
    const plannedAliasCollisions = missingOwnerRoutes.filter((routeKey) => (
      routeOwnersAtPath(routeKey).some(({ job: plannedOwner, kind }) => (
        kind === 'planned-active-alias' && plannedOwner !== owner
      ))
    ));
    if (plannedAliasCollisions.length > 0) {
      for (const routeKey of plannedAliasCollisions) {
        unresolvedIdlessRouteKeys.add(routeKey);
        unresolvedIdlessRouteReasons.set(
          routeKey,
          'historical active alias collides with a different planned active owner',
        );
      }
      continue;
    }
    const expiredCollisions = missingOwnerRoutes.filter((routeKey) => (
      routeOwnersAtPath(routeKey).some(({ job: expiredOwner, kind }) => (
        (kind === 'existing-expired' || kind === 'historical-expired')
        && !sharesProvenPostingIdentity(owner, expiredOwner, listingIdentities.isAmbiguous)
      ))
    ));
    if (expiredCollisions.length > 0) {
      for (const routeKey of expiredCollisions) {
        unresolvedIdlessRouteKeys.add(routeKey);
        unresolvedIdlessRouteReasons.set(
          routeKey,
          'historical active alias collides with an expired route of unknown or different posting identity',
        );
      }
      continue;
    }
    const recoveredCandidateCollisions = missingOwnerRoutes.filter((routeKey) => (
      (recoveredCandidateOwnersByPath.get(routeKey) || []).some((candidate) => (
        !sharesProvenPostingIdentity(owner, candidate, listingIdentities.isAmbiguous)
      ))
    ));
    if (recoveredCandidateCollisions.length > 0) {
      for (const routeKey of recoveredCandidateCollisions) {
        unresolvedIdlessRouteKeys.add(routeKey);
        unresolvedIdlessRouteReasons.set(
          routeKey,
          'historical active alias collides with a recovered candidate of unknown or different posting identity',
        );
      }
      continue;
    }
    if (missingOwnerRoutes.length > 0) {
      for (const routeKey of missingOwnerRoutes) {
        const ownersAtPath = routeOwnersAtPath(routeKey);
        if (!ownersAtPath.some(({ job: activeOwner, kind }) => (
          kind === 'planned-active-alias' && activeOwner === owner
        ))) {
          addRouteOwnerToGroup(routeOwnersByEmittedPath, routeKey, {
            emittedPath: routeKey,
            job: owner,
            kind: 'planned-active-alias',
          });
        }
      }
      activeRouteMergePlans.push({
        owner,
        historicalRoutes,
        ownerCanton,
      });
    }
  }

  // The expired renderer uses recorded canton history; active pages use the
  // current owner's canton. Compare the candidate's complete expired output
  // with routes the current slice or a planned active alias will actually emit.
  // Historical snapshots and active-route evidence are ownership evidence,
  // not output by themselves; transferred aliases enter the map as planned.
  phase('recovered route collisions');
  const recoveredExpiredRouteCollisions = new Set();
  for (const [candidate, archiveCandidate] of recoveredCandidateEntries) {
    let suppressedRoute = true;
    while (suppressedRoute) {
      suppressedRoute = false;
      for (const route of emittedRouteEntries(archiveCandidate)) {
        const activeOwners = activePageOwnersAtPath(route.emittedPath);
        if (activeOwners.length === 0) continue;
        const samePostingOwners = activeOwners.every((activeOwner) => (
          sharesProvenPostingIdentity(candidate, activeOwner, listingIdentities.isAmbiguous)
        ));
        if (samePostingOwners && suppressExpiredRoute(archiveCandidate, route)) {
          suppressedRoute = true;
          break;
        }
        recoveredExpiredRouteCollisions.add(route.emittedPath);
      }
    }
  }
  if (recoveredExpiredRouteCollisions.size > 0) {
    console.error(
      `::error::backfill-expired-from-history/${sliceFile}: refusing to write the slice; `
      + `${recoveredExpiredRouteCollisions.size} recovered expired route(s) would duplicate an active route`,
    );
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostById.size + lostByStableIdentity.size,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: 0,
      refusedRoutes: recoveredExpiredRouteCollisions.size,
      ...refusalDetails('recovered-route-collision', [...recoveredExpiredRouteCollisions]),
    };
  }

  // A route-only row has no posting identity to transfer. Any exact route
  // overlap with an active owner or a planned active alias is ambiguous, even
  // when the overlapping path is already served by that active posting.
  for (const candidate of lostByStableIdentity.values()) {
    if (!routeOnlyCandidates.has(candidate)) continue;
    const activeCollisions = [...emittedRouteKeys(candidate, { active: true })]
      .filter((routeKey) => routeOwnersAtPath(routeKey).some(({ kind }) => (
        kind === 'current-active'
        || kind === 'planned-active-alias'
        || kind === 'active-route-evidence'
      )));
    for (const routeKey of activeCollisions) {
      unresolvedIdlessRouteKeys.add(routeKey);
      unresolvedIdlessRouteReasons.set(
        routeKey,
        'route-only candidate overlaps an active route with unknown posting identity',
      );
    }
  }

  phase('route-only collisions done');
  const alreadyServedRouteKeys = new Set([
    ...currentRouteKeys,
    ...existing.flatMap((entry) => [...emittedRouteKeys(entry || {})]),
    ...historicalExpiredRoutePaths,
  ]);
  for (const routeKey of unresolvedIdlessRouteKeys) {
    if (alreadyServedRouteKeys.has(routeKey) && !unresolvedIdlessRouteReasons.has(routeKey)) {
      unresolvedIdlessRouteKeys.delete(routeKey);
    }
  }
  if (unresolvedIdlessRouteKeys.size > 0) {
    const reasons = [...new Set(unresolvedIdlessRouteReasons.values())];
    const reasonText = reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
    console.error(
      `::error::backfill-expired-from-history/${sliceFile}: refusing to write the slice; `
      + `${unresolvedIdlessRouteKeys.size} historical route(s) have unresolved posting identity${reasonText}`,
    );
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostById.size + lostByStableIdentity.size,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: 0,
      refusedRoutes: unresolvedIdlessRouteKeys.size,
      ...refusalDetails('unresolved-posting-identity', [...unresolvedIdlessRouteKeys]),
    };
  }

  const lostCount = lostById.size + lostByStableIdentity.size;

  const activeRouteUpdatedOwners = new Set();
  for (const { owner, historicalRoutes, ownerCanton } of activeRouteMergePlans) {
    const activeRoutesBefore = emittedRouteKeys(owner, { active: true });
    let routesChanged = false;
    let routeCantonsChanged = false;
    for (const { locale, slug } of historicalRoutes) {
      const ownerPath = emittedRouteKey(locale, slug, ownerCanton);
      if (!slug || !ownerPath || activeRoutesBefore.has(ownerPath)) continue;
      const existingAliases = Array.isArray(owner.previousSlugsByLocale?.[locale])
        ? owner.previousSlugsByLocale[locale]
        : [];
      const aliasAlreadyRecorded = existingAliases.includes(slug);
      const cap = Math.max(
        DEFAULT_PREV_SLUG_CAP,
        existingAliases.length + (aliasAlreadyRecorded ? 0 : 1),
      );
      addPreviousSlugForLocale(
        owner,
        locale,
        slug,
        cap,
        `backfill-expired-from-history/${sliceFile}/active-route-history`,
        { syncLegacy: false },
      );
      routesChanged ||= !aliasAlreadyRecorded;
      routeCantonsChanged = setExpiredRouteCanton(owner, locale, slug, ownerCanton)
        || routeCantonsChanged;
    }

    const activeRoutesAfter = emittedRouteKeys(owner, { active: true });
    const unrepresentedRoutes = historicalRoutes.filter(({ locale, slug }) => (
      !activeRoutesAfter.has(emittedRouteKey(locale, slug, ownerCanton))
    ));
    if (unrepresentedRoutes.length > 0) {
      console.error(
        `::error::backfill-expired-from-history/${sliceFile}: refusing to write the slice; `
        + `${unrepresentedRoutes.length} historical active route(s) could not be represented safely`,
      );
      return {
        crawlerKey,
        scannedCommits: sliceCommits.length,
        lost: lostById.size + lostByStableIdentity.size,
        added: 0,
        recovered: 0,
        enriched: 0,
        activeEnriched: 0,
        refusedRoutes: unrepresentedRoutes.length,
      ...refusalDetails('unrepresented-active-route', unrepresentedRoutes.map(({ locale, slug }) => `${locale}:${slug}`)),
      };
    }
    if (routesChanged || routeCantonsChanged) activeRouteUpdatedOwners.add(owner);
  }

  // Active aliases are emitted under the active owner's current canton. Keep
  // the archive's per-alias canton map in sync as well, including aliases that
  // were already present and therefore needed no transfer plan. On expiry,
  // this preserves the exact path the active page served.
  for (const owner of currentJobs) {
    const ownerCanton = resolveJobCanton(owner || {});
    if (!ownerCanton) continue;
    for (const [locale, aliases] of Object.entries(owner.previousSlugsByLocale || {})) {
      if (!Array.isArray(aliases)) continue;
      for (const slug of aliases) {
        if (setExpiredRouteCanton(owner, locale, slug, ownerCanton)) {
          activeRouteUpdatedOwners.add(owner);
        }
      }
    }
  }
  const activeRouteUpdates = activeRouteUpdatedOwners.size;

  // What the archive serves before this run: none of it may disappear below.
  const routesServedBefore = [
    ...existing.flatMap((entry) => [...emittedRouteKeys(entry || {})]),
    ...historicalExpiredRoutePaths,
    ...historicalActiveRoutePaths,
  ];
  const indexArchive = () => createSameIdentityArchiveIndex(archiveEntries, {
    activeJobs: currentJobs,
    isAmbiguousIdentity: listingIdentities.isAmbiguous,
  });

  /**
   * Fold one recovered payload (historical archive row or lost active job) into
   * the archive. Both merge directions carry the loser's routes: the newer
   * payload wins the content, never the right to forget a served URL. Work done
   * on an already-archived posting is counted in `recoveredFromHistory`.
   *
   * @returns {boolean} whether `entry` became a new record
   */
  const recover = (entry, identityIndex) => {
    const source = `backfill-expired-from-history/${sliceFile}`;
    const scopeKey = expiredPrimaryMergeScopeKey(entry);
    const sameScopeRows = scopeKey ? [...(archiveEntriesByMergeScope.get(scopeKey) || [])] : [];
    const previous = sameScopeRows.length === 1
      && sharesProvenPostingIdentity(sameScopeRows[0], entry, listingIdentities.isAmbiguous)
      ? sameScopeRows[0]
      : null;
    const identityOwners = new Set();
    for (const identity of archiveRecordSourceIdentities(entry)) {
      for (const candidate of archiveEntriesByIdentity.get(
        archiveIdentityKey(entry?.companyKey, identity),
      ) || []) identityOwners.add(candidate);
    }
    const matchingIdentityOwners = [...identityOwners].filter((candidate) => (
      sameArchiveCompanyNamespace(candidate, entry)
      && sharesProvenPostingIdentity(candidate, entry, listingIdentities.isAmbiguous)
    ));

    if (!previous && matchingIdentityOwners.length === 1) {
      const [owner] = matchingIdentityOwners;
      let routeCapRefused = false;
      let changed = false;
      identityIndex.update(owner, () => {
        unindexArchiveEntry(owner);
        const routesChanged = mergeExpiredRouteEvidence(
          owner,
          addExpiredFallbackAliases(owner, entry),
          source,
          { onLegacyRouteCapRefusal: () => { routeCapRefused = true; } },
        );
        const identitiesChanged = mergeSourceIdentityHistory(owner, entry);
        changed = routesChanged || identitiesChanged;
        indexArchiveEntry(owner);
      });
      if (!routeCapRefused) {
        if (changed) recoveredFromHistory++;
        return false;
      }
    }

    if (!previous) {
      archiveEntries.push(entry);
      indexArchiveEntry(entry);
      identityIndex.add(entry);
      return true;
    }
    if (compareExpiredAt(previous.expiredAt, entry.expiredAt) < 0) {
      let routeCapRefused = false;
      mergeExpiredRouteEvidence(
        entry,
        addExpiredFallbackAliases(entry, previous),
        source,
        { onLegacyRouteCapRefusal: () => { routeCapRefused = true; } },
      );
      // The existing record remains the proven owner of its older routes;
      // replacing it would turn a cap refusal into an archive 404.
      if (routeCapRefused) return false;
      const previousIndex = archiveEntries.indexOf(previous);
      identityIndex.remove(previous);
      unindexArchiveEntry(previous);
      mergeSourceIdentityHistory(entry, previous);
      if (previousIndex >= 0) archiveEntries.splice(previousIndex, 1, entry);
      else archiveEntries.push(entry);
      indexArchiveEntry(entry);
      identityIndex.add(entry);
      recoveredFromHistory++;
      return false;
    }
    identityIndex.update(previous, () => {
      unindexArchiveEntry(previous);
      const routeEvidenceChanged = mergeExpiredRouteEvidence(
        previous,
        addExpiredFallbackAliases(previous, entry),
        source,
      );
      const sourceIdentityChanged = mergeSourceIdentityHistory(previous, entry);
      if (routeEvidenceChanged || sourceIdentityChanged) recoveredFromHistory++;
      indexArchiveEntry(previous);
    });
    return false;
  };

  // Newest first: of several recovered payloads of one posting, the latest
  // becomes the record and the older ones only add what it does not serve.
  const newestFirst = (a, b) => compareExpiredAt(b.expiredAt, a.expiredAt);
  let recoveredFromHistory = 0;
  const historicalIdentityIndex = indexArchive();
  // Identical payload snapshots are deduplicated, but every distinct historical
  // row is recovered. Ownership is resolved by company scope and posting
  // identity rather than by a bare primary slug.
  const historicalEntries = mergeHistoricalRecoveryRepresentatives(
    [...historicalExpiredOwners.values()].map(materializeHistoricalOwnerRoutes),
    listingIdentities.isAmbiguous,
  )
    .filter((entry) => entry?.slug && !currentArchivePayloads.has(payloadFingerprint(entry)))
    .sort(newestFirst);
  for (const entry of historicalEntries) {
    if (recover(entry, historicalIdentityIndex)) recoveredFromHistory++;
  }

  // A route-only candidate has no posting identity to match against an archive
  // row. A same-company primary route scope cannot represent both payloads
  // without transferring identity, so only that merge scope is considered.
  const coveredRouteKeys = new Set([
    ...currentRouteKeys,
    ...archiveEntries.flatMap((entry) => [...emittedRouteKeys(entry || {})]),
  ]);
  const alreadyServedRouteOnlyCandidates = new WeakSet();
  const refusedRouteOnlyCollisionKeys = new Set();
  for (const candidate of lostByStableIdentity.values()) {
    const scopeKey = expiredPrimaryMergeScopeKey(candidate);
    if (!routeOnlyCandidates.has(candidate)
      || !scopeKey
      || !archiveEntriesByMergeScope.has(scopeKey)) continue;
    const uncovered = [...emittedRouteKeys(candidate, { active: true })]
      .filter((routeKey) => !coveredRouteKeys.has(routeKey));
    if (uncovered.length === 0) {
      // The existing archive/current generation already serves every route.
      // Do not send this identity-less payload through the slug merge anyway:
      // that could still replace or enrich the known archive row.
      alreadyServedRouteOnlyCandidates.add(candidate);
      continue;
    }
    for (const routeKey of uncovered) refusedRouteOnlyCollisionKeys.add(routeKey);
  }
  if (refusedRouteOnlyCollisionKeys.size > 0) {
    console.error(
      `::error::backfill-expired-from-history/${sliceFile}: refusing to write the slice; `
      + `${refusedRouteOnlyCollisionKeys.size} route(s) from route-only candidate(s) collide with an archived slug `
      + 'and cannot be represented without guessing identity',
    );
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostById.size + lostByStableIdentity.size,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: 0,
      refusedRoutes: refusedRouteOnlyCollisionKeys.size,
      ...refusalDetails('route-only-collision', [...refusedRouteOnlyCollisionKeys]),
    };
  }

  // Older archives predate sourceIdentity/firstSeenAt. Enrich them from the
  // complete Git history before merging newly recovered drops. This also
  // handles a vacancy that is active again today: it need not be absent from
  // the current slice to have a durable first-seen date in the archive.
  const metadata = historicalIndex.enrich(archiveEntries);
  const activeMetadata = historicalIndex.enrichActive(currentJobs);

  let added = 0;
  // Indexed after the enrichment, which gives legacy rows their sourceIdentity.
  const lostIdentityIndex = indexArchive();
  for (const entry of [...lostById.values(), ...lostByStableIdentity.values()]
    .filter((candidate) => !alreadyServedRouteOnlyCandidates.has(candidate))
    .map((candidate) => recoveredCandidateEntries.get(candidate) || buildExpiredEntry(candidate))
    .sort(newestFirst)) {
    if (recover(entry, lostIdentityIndex)) added++;
  }

  // Repair AFTER the historical merge, never before: stamping the run
  // timestamp on a legacy entry first would make it the MOST recent one, so
  // the refresh above would never fire and the degraded payload would keep the
  // soft landing — the comparator inverts, instead of the entry losing as it
  // does with an unorderable value.
  const repaired = normalizeExpiredAtEntries(
    archiveEntries,
    { source: `backfill-expired-from-history/${sliceFile}` },
  );

  // A repair adds no slug, so `added` stays put: write it out anyway,
  // otherwise the unorderable value survives on disk until an unrelated add.
  // Collapse by the archive writer's company-scoped route ownership before
  // writing. The preflight above already refused any exact public-path overlap
  // or unrepresentable canton history.
  phase('collapsing archive');
  const archived = collapseDuplicateRouteEntries(
    [...archiveEntries].sort((a, b) => compareExpiredAt(b.expiredAt, a.expiredAt)),
    { source: 'backfill-expired-from-history' },
  ).entries;
  // Last boundary before the write: whatever step caused it, a route the
  // archive served on entry and nobody serves now would become a 404. Keep the
  // archive on disk untouched and say which routes were at stake.
  const servedAfter = new Set([
    ...archived.flatMap((entry) => [...emittedRouteKeys(entry || {})]),
    ...currentJobs.flatMap((entry) => [...emittedRouteKeys(entry || {}, { active: true })]),
  ]);
  const droppedRoutes = [...new Set(routesServedBefore)].filter((routeKey) => !servedAfter.has(routeKey));
  if (droppedRoutes.length > 0) {
    console.error(
      `::error::backfill-expired-from-history/${sliceFile}: refusing to write the archive, `
      + `${droppedRoutes.length} previously served route(s) would be lost; route details are omitted`,
    );
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostCount,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: activeMetadata.enrichedEntries,
      refusedRoutes: droppedRoutes.length,
      ...refusalDetails('dropped-served-route', droppedRoutes),
    };
  }
  if (report) {
    report.timings.collisionChecksMs = Math.round(performance.now() - walkFinishedAt);
    const snapshotAfter = routeOwnerSnapshot(archived, routeOwnerSnapshot(currentJobs));
    const { lost, ownerChanged, restoredByLocale } = compareRouteSnapshots(snapshotBefore, snapshotAfter);
    report.refused = false;
    report.unrestoredLegitimateRoutes = 0;
    report.lost = lost;
    report.ownerChanged = ownerChanged;
    report.restoredByLocale = restoredByLocale;
  }
  // Even a no-op must pass the served-route check above. Otherwise a
  // historical active path can disappear when its current row keeps the same
  // identity and metadata but moves to another canton.
  if (
    added === 0
    && recoveredFromHistory === 0
    && repaired === 0
    && metadata.enrichedEntries === 0
    && activeMetadata.enrichedEntries === 0
    && activeRouteUpdates === 0
  ) {
    return {
      crawlerKey,
      scannedCommits: sliceCommits.length,
      lost: lostCount,
      added: 0,
      recovered: 0,
      enriched: 0,
      activeEnriched: 0,
    };
  }
  const stagingStartedAt = performance.now();
  if (!dryRun) {
    if (activeMetadata.enrichedEntries > 0 || activeRouteUpdates > 0) {
      const nextPayload = Array.isArray(currentPayload)
        ? currentJobs
        : { ...(currentPayload || {}), jobs: currentJobs };
      const activeOutputPath = stagingDir
        ? path.join(stagingDir, 'active', sliceFile)
        : currentPath;
      fs.mkdirSync(path.dirname(activeOutputPath), { recursive: true });
      writeJsonAtomic(activeOutputPath, nextPayload);
    }
    // Shard placement + the 90 MB ceiling on every file.
    if (
      added > 0
      || recoveredFromHistory > 0
      || repaired > 0
      || metadata.enrichedEntries > 0
    ) {
      if (stagingDir) {
        const stagedExpiredDir = path.join(stagingDir, 'expired');
        fs.mkdirSync(stagedExpiredDir, { recursive: true });
        for (const shard of existingShards) {
          const stagedPath = path.join(stagedExpiredDir, shard.name);
          if (!fs.existsSync(stagedPath)) {
            fs.symlinkSync(path.resolve(shard.path), stagedPath);
          }
        }
        writeExpiredSliceRows(crawlerKey, archived, {
          dir: stagedExpiredDir,
          existing: existingShards,
        });
      } else {
        writeExpiredSliceRows(crawlerKey, archived, { dir: expiredDir, existing: existingShards });
      }
    }
  }
  if (report) report.timings.stagingMs = Math.round(performance.now() - stagingStartedAt);
  return {
    crawlerKey,
    scannedCommits: sliceCommits.length,
    lost: lostCount,
    added: added + recoveredFromHistory,
    recovered: recoveredFromHistory,
    enriched: metadata.enrichedEntries,
    activeEnriched: activeMetadata.enrichedEntries + activeRouteUpdates,
  };
}

function emptyBackfillSummary() {
  return {
    crawlers: 0,
    withDrops: 0,
    withMetadata: 0,
    addedTotal: 0,
    recoveredTotal: 0,
    enrichedTotal: 0,
    activeEnrichedTotal: 0,
    lostTotal: 0,
    scannedTotal: 0,
    refusedArchives: 0,
    refusedRoutesTotal: 0,
    applySkippedDueToRefusals: false,
  };
}

function addSliceResultToSummary(summary, result) {
  summary.crawlers++;
  summary.scannedTotal += result.scannedCommits;
  if (result.lost > 0) summary.withDrops++;
  summary.lostTotal += result.lost;
  if (result.refusedRoutes > 0) summary.refusedArchives++;
  summary.refusedRoutesTotal += result.refusedRoutes || 0;
  summary.addedTotal += result.added;
  summary.recoveredTotal += result.recovered;
  summary.enrichedTotal += result.enriched;
  summary.activeEnrichedTotal += result.activeEnriched || 0;
  if (result.enriched > 0 || result.activeEnriched > 0) summary.withMetadata++;
}

function collectStagedOutputs(stagingDir, byCrawlerDir, expiredDir) {
  const outputs = [];
  for (const [kind, targetDir] of [['active', byCrawlerDir], ['expired', expiredDir]]) {
    const stagedDir = path.join(stagingDir, kind);
    if (!fs.existsSync(stagedDir)) continue;
    for (const name of fs.readdirSync(stagedDir)) {
      const stagedPath = path.join(stagedDir, name);
      const info = fs.lstatSync(stagedPath);
      if (!info.isFile()) continue;
      outputs.push({ stagedPath, targetPath: path.join(targetDir, name) });
    }
  }
  return outputs.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function hashFileSync(filePath) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function removeApplyTemporaryDirectories(
  prepared,
  removeTemporaryDirectory = (directory) => fs.rmSync(directory, { recursive: true, force: true }),
) {
  const errors = [];
  for (const item of prepared) {
    if (!item.temporaryDir) continue;
    try {
      removeTemporaryDirectory(item.temporaryDir);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function rollbackStagedOutputs(outputs) {
  const errors = [];
  for (const item of [...outputs].reverse()) {
    let rollbackDir;
    try {
      if (item.existed) {
        rollbackDir = fs.mkdtempSync(path.join(
          item.targetDir,
          `.${path.basename(item.targetPath)}.backfill-rollback-`,
        ));
        const restorePath = path.join(rollbackDir, path.basename(item.targetPath));
        const backupInfo = lstatOrNull(item.rollbackPath);
        if (!backupInfo) {
          throw new Error(`Missing rollback backup at ${item.rollbackPath}`);
        }
        if (!backupInfo.isFile() || backupInfo.isSymbolicLink()) {
          throw new Error(`Refusing unsafe rollback backup type at ${item.rollbackPath}`);
        }
        fs.copyFileSync(item.rollbackPath, restorePath);
        fs.chmodSync(restorePath, item.mode);
        fs.renameSync(restorePath, item.targetPath);
      } else {
        const current = lstatOrNull(item.targetPath);
        if (current) {
          if (!current.isFile() || current.isSymbolicLink()) {
            throw new Error(`Refusing to remove an unsafe rollback target type at ${item.targetPath}`);
          }
          fs.rmSync(item.targetPath);
        }
      }
    } catch (error) {
      errors.push(error);
    } finally {
      if (rollbackDir) {
        try {
          fs.rmSync(rollbackDir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
    }
  }
  return errors;
}

function stagedApplyFailure(primaryError, rollbackErrors = [], cleanupErrors = []) {
  if (rollbackErrors.length === 0 && cleanupErrors.length === 0) return primaryError;
  const detail = [
    `original: ${primaryError?.message || String(primaryError)}`,
    ...rollbackErrors.map((error) => `rollback: ${error?.message || String(error)}`),
    ...cleanupErrors.map((error) => `cleanup: ${error?.message || String(error)}`),
  ].join('; ');
  return new AggregateError(
    [primaryError, ...rollbackErrors, ...cleanupErrors],
    `Staged output transaction failed (${detail})`,
    { cause: primaryError },
  );
}

/** Replace all staged targets as one recoverable filesystem transaction. */
export function applyStagedOutputs(outputs, {
  replaceStagedFile = (stagedPath, targetPath) => fs.renameSync(stagedPath, targetPath),
  removeTemporaryDirectory = (directory) => fs.rmSync(directory, { recursive: true, force: true }),
} = {}) {
  const prepared = [];
  const attempted = [];
  let primaryError = null;
  try {
    const targetPaths = new Set();
    for (const output of outputs) {
      const stagedPath = path.resolve(output.stagedPath);
      const targetPath = path.resolve(output.targetPath);
      if (targetPaths.has(targetPath)) throw new Error(`Duplicate staged target path: ${targetPath}`);
      targetPaths.add(targetPath);
      const stagedInfo = fs.lstatSync(stagedPath);
      if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink()) {
        throw new Error(`Refusing unsafe staged output type at ${stagedPath}`);
      }

      const targetDir = path.dirname(targetPath);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetDirInfo = fs.lstatSync(targetDir);
      if (!targetDirInfo.isDirectory() || targetDirInfo.isSymbolicLink()) {
        throw new Error(`Refusing unsafe destination directory type at ${targetDir}`);
      }
      const originalStat = lstatOrNull(targetPath);
      if (originalStat && (!originalStat.isFile() || originalStat.isSymbolicLink())) {
        throw new Error(`Refusing unsafe destination target type at ${targetPath}`);
      }

      const originalHash = originalStat ? hashFileSync(targetPath) : null;
      const temporaryDir = fs.mkdtempSync(path.join(
        targetDir,
        `.${path.basename(targetPath)}.backfill-apply-`,
      ));
      const item = {
        stagedPath,
        targetPath,
        targetDir,
        temporaryDir,
        temporaryPath: path.join(temporaryDir, 'replacement'),
        rollbackPath: path.join(temporaryDir, 'original'),
        existed: Boolean(originalStat),
        originalHash,
        originalStat,
        mode: (originalStat || stagedInfo).mode & 0o7777,
      };
      prepared.push(item);
      fs.copyFileSync(stagedPath, item.temporaryPath);
      fs.chmodSync(item.temporaryPath, item.mode);
      if (item.existed) {
        fs.copyFileSync(targetPath, item.rollbackPath);
        fs.chmodSync(item.rollbackPath, item.mode);
        if (hashFileSync(item.rollbackPath) !== item.originalHash) {
          throw new Error(`Destination changed while preparing staged-output backup: ${targetPath}`);
        }
      }
    }

    for (const item of prepared) {
      const current = lstatOrNull(item.targetPath);
      if (item.existed) {
        if (!current || !current.isFile() || current.isSymbolicLink()
          || current.dev !== item.originalStat.dev
          || current.ino !== item.originalStat.ino
          || current.mode !== item.originalStat.mode
          || hashFileSync(item.targetPath) !== item.originalHash) {
          throw new Error(`Destination changed during staged-output preflight: ${item.targetPath}`);
        }
      } else if (current) {
        throw new Error(`Destination appeared during staged-output preflight: ${item.targetPath}`);
      }
      attempted.push(item);
      replaceStagedFile(item.temporaryPath, item.targetPath);
    }
  } catch (error) {
    primaryError = error;
  }

  if (primaryError) {
    const rollbackErrors = rollbackStagedOutputs(attempted);
    const cleanupErrors = removeApplyTemporaryDirectories(prepared, removeTemporaryDirectory);
    throw stagedApplyFailure(primaryError, rollbackErrors, cleanupErrors);
  }

  const cleanupErrors = removeApplyTemporaryDirectories(prepared, removeTemporaryDirectory);
  if (cleanupErrors.length > 0) {
    const detail = cleanupErrors.map((error) => error?.message || String(error)).join('; ');
    throw new AggregateError(
      cleanupErrors,
      `All staged outputs were applied successfully, but transaction cleanup failed: ${detail}`,
    );
  }
  return outputs.length;
}

/**
 * Prepare every selected crawler against repository state before applying any
 * staged output. A thrown history read, validation, or planning error leaves
 * all active and expired repository files untouched.
 */
export function prepareAndApplySlices(files, {
  rootDir = ROOT,
  byCrawlerDir = path.join(rootDir, 'data', 'jobs', 'by-crawler'),
  expiredDir = path.join(rootDir, 'data', 'jobs', 'expired', 'by-crawler'),
  maxCommits = MAX_COMMITS,
  dryRun = DRY_RUN,
  stagingParentDir = tmpdir(),
  onSliceResult = null,
  reports = null,
} = {}) {
  fs.mkdirSync(stagingParentDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingParentDir, 'backfill-expired-from-history-'));
  const summary = emptyBackfillSummary();
  try {
    for (const file of files) {
      const report = reports ? {} : null;
      const result = processSlice(file, {
        rootDir,
        byCrawlerDir,
        expiredDir,
        maxCommits,
        dryRun,
        stagingDir,
        report,
      });
      if (!result) continue;
      if (reports) {
        reports.push({
          crawlerKey: result.crawlerKey,
          refusedRoutes: result.refusedRoutes || 0,
          collisions: result.refusedRoutes || 0,
          recovered: result.recovered,
          added: result.added,
          ...report,
        });
      }
      addSliceResultToSummary(summary, result);
      onSliceResult?.(result);
    }
    if (!dryRun && summary.refusedArchives > 0) {
      summary.applySkippedDueToRefusals = true;
    } else if (!dryRun) {
      applyStagedOutputs(collectStagedOutputs(stagingDir, byCrawlerDir, expiredDir));
    }
    return summary;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function main() {
  if (!fs.existsSync(BY_CRAWLER_DIR)) {
    console.error(`❌ ${BY_CRAWLER_DIR} not found`);
    process.exit(1);
  }
  const files = listSliceFiles();
  if (files.length === 0) {
    console.log('ℹ️  No slice files matched.');
    return;
  }
  console.log(`🧮 Backfilling expired slices from history${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`   crawlers: ${files.length}, history cap: ${MAX_COMMITS || 'unbounded'}`);

  const reports = process.env.BACKFILL_REPORT_PATH ? [] : null;
  const summary = prepareAndApplySlices(files, {
    reports,
    onSliceResult: (result) => {
      if (result.lost > 0 || result.enriched > 0 || result.activeEnriched > 0
        || result.refusedRoutes > 0 || process.env.VERBOSE === '1') {
        console.log(
          `  ${result.crawlerKey}: scanned=${result.scannedCommits} lost=${result.lost} added=${result.added} recovered=${result.recovered} metadata=${result.enriched} activeMetadata=${result.activeEnriched || 0} refusedRoutes=${result.refusedRoutes || 0}`,
        );
      }
    },
  });
  console.log('');
  if (reports) {
    writeJsonAtomic(process.env.BACKFILL_REPORT_PATH, {
      dryRun: DRY_RUN,
      maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
      summary,
      crawlers: reports,
    });
  }
  const exitCode = backfillExitCode(summary);
  if (exitCode === 0) {
    console.log(`✅ Done. Crawlers: ${summary.crawlers}, with drops: ${summary.withDrops}`);
  } else {
    console.log(`⚠️  Backfill incomplete: ${summary.refusedArchives} archive slice(s) were refused.`);
  }
  console.log(`   Total lost: ${summary.lostTotal}, newly archived: ${summary.addedTotal}`);
  console.log(`   Recovered historical archive entries: ${summary.recoveredTotal}`);
  console.log(`   Archives enriched: ${summary.enrichedTotal} entries across ${summary.withMetadata} crawlers`);
  console.log(`   Active slices enriched: ${summary.activeEnrichedTotal} jobs`);
  console.log(`   Total commits scanned: ${summary.scannedTotal}`);
  console.log(`   Refused archive slices: ${summary.refusedArchives}; refused routes: ${summary.refusedRoutesTotal}`);
  if (summary.applySkippedDueToRefusals) {
    console.log('   No staged outputs were applied because at least one archive slice was refused.');
  }
  if (exitCode !== 0) {
    console.error(
      `::error::Backfill refused ${summary.refusedRoutesTotal} route(s) across ${summary.refusedArchives} archive slice(s); exiting with the refusal status so the workflow records them and continues`,
    );
    process.exitCode = exitCode;
  }
}

/**
 * Exit status contract with the workflow loop: 0 = done, 3 = at least one
 * slice was refused for a route collision (expected, deterministic outcome:
 * nothing was written, the loop records the crawler and moves on), any other
 * non-zero status is a real error.
 */
export const BACKFILL_REFUSED_EXIT_CODE = 3;

export function backfillExitCode(summary) {
  return summary?.refusedArchives > 0 ? BACKFILL_REFUSED_EXIT_CODE : 0;
}

// Importing the module (tests) must not start a repository-wide backfill.
if (isInvokedDirectly(import.meta.url)) main();

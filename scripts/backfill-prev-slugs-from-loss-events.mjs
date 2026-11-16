#!/usr/bin/env node
/**
 * One-shot recovery for previousSlugs entries dropped by past crawler runs.
 *
 * Background: a writer bug (shared-jobs-crawler.ensureLocaleFields wrote to
 * the flat `previousSlugs` array only, never to `previousSlugsByLocale`) plus
 * the absence of a slice-level safety net caused 1,289 historical slugs to
 * be silently removed from 43 per-crawler slice files over 60 days. After
 * the fix landed (commit: this PR's predecessor), the bleeding stopped — but
 * 336 distinct URLs are still missing from current slices and would 404 on
 * the next deploy unless we backfill them from git history.
 *
 * Input: a JSON file listing { jobId, file, slugs[] } produced by the scan
 *        scripts/scan-prev-slug-losses.mjs (or the /tmp/recoverable-slugs.json
 *        artifact from the audit). Pass via --input <path>; defaults to
 *        /tmp/recoverable-slugs.json.
 *
 * Per slug we replay Git revisions and require one historical locale plus one
 * unambiguous current posting owner joined through source identity. Legacy
 * flat-only, identity-less, conflicting, denylisted, and cross-owner evidence
 * is reported but never written.
 *
 * Usage:
 *   node scripts/backfill-prev-slugs-from-loss-events.mjs [--input /tmp/recoverable-slugs.json] [--report /tmp/recovery-plan.json] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { LOCALES, stableSlugHash } from './lib/dedicated-crawler-common.mjs';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';
import { createCatFileBatch } from './lib/git-cat-file-batch.mjs';
import { sourcePostingUrlHref } from './lib/job-identity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BY_CRAWLER_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');

const CAP = 20;
// A recovery run may have proof for more history than the live writer's
// per-locale cap can hold. Keep a bounded emergency headroom so those proven
// routes become reachable without turning malformed input into an unbounded
// history array. The incident that motivated #9056 had 17 proven slugs in a
// full bucket, which fits in this one-cap overflow window.
const RECOVERY_OVERFLOW_MULTIPLIER = 2;

/**
 * data/prev-slug-restore-denylist.json lists {file, jobId, slug} pairs that
 * were REMOVED ON PURPOSE from slice histories by the umantis cross-tenant
 * decontamination (#4055, squash 028d6c1147) — slugs of OTHER companies that
 * the tenant-id collision had pinned onto the wrong slice, plus censused
 * garbage-title slugs. The scan (scripts/scan-prev-slug-losses.mjs) cannot
 * tell an intentional removal from an accidental loss, so without this guard
 * the backfill "recovers" the poison right back: run 29106416912 (commit
 * efed987db) re-imported kanton-aargau/GKB slugs into ksa.json that way.
 * Generated deterministically by scripts/build-prev-slug-restore-denylist.mjs.
 */
const DENYLIST_PATH = path.resolve(ROOT, 'data', 'prev-slug-restore-denylist.json');

/**
 * Canonical denylist lookup key. NUL separator cannot occur in either part.
 * @param {string} file slice basename, e.g. "ksa.json"
 * @param {string} slug
 * @returns {string}
 */
export function denylistKey(file, slug) {
  return `${file}\u0000${slug}`;
}

/**
 * Load the restore denylist as a Set keyed on `file\0slug`.
 *
 * Keyed on file+slug, NOT the full (file, jobId, slug) triple: a denylisted
 * slug is foreign to (or garbage in) its whole slice, and the recovery path
 * can re-home a slug onto a DIFFERENT job of the same file via the hash-tail
 * redirect in resolveRecoveryTarget — run 29106416912 spread one denylisted
 * ksa slug across three different jobs exactly that way. jobId in the file
 * is provenance only.
 *
 * The committed file is required: a missing or invalid denylist throws so the
 * recovery guard can never be silently disabled by a broken checkout/commit.
 *
 * @param {string} [file]
 * @returns {Set<string>}
 */
export function loadRestoreDenylist(file = DENYLIST_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read previous-slug restore denylist at ${file}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed previous-slug restore denylist at ${file}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.entries)
    || !parsed.entries.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.file === 'string' && entry.file.trim()
      && typeof entry.jobId === 'string' && entry.jobId.trim()
      && typeof entry.slug === 'string' && entry.slug.trim())) {
    throw new Error(`Invalid previous-slug restore denylist shape at ${file}`);
  }
  const set = new Set(parsed.entries.map((entry) => denylistKey(entry.file, entry.slug)));
  return set;
}

/**
 * Drop denylisted (file, slug) pairs from a scan-produced recover list.
 * Entries whose slugs are all denylisted are removed outright.
 *
 * @param {Array<{jobId: string, file: string, slugs: string[]}>} recoverList
 * @param {Set<string>} denylist from loadRestoreDenylist()
 * @returns {{entries: Array<{jobId: string, file: string, slugs: string[]}>, skipped: number}}
 */
export function filterDenylistedSlugs(recoverList, denylist) {
  if (!denylist || denylist.size === 0) return { entries: recoverList, skipped: 0 };
  let skipped = 0;
  const entries = [];
  for (const e of recoverList) {
    const kept = (e.slugs || []).filter((s) => {
      const hit = denylist.has(denylistKey(e.file, s));
      if (hit) skipped++;
      return !hit;
    });
    if (kept.length > 0) entries.push({ ...e, slugs: kept });
  }
  return { entries, skipped };
}

const HASH_TAIL_RE = /-([a-z0-9]{6})$/;

/**
 * Whether a job already serves a route, either as an active slug or as a
 * previous-slug bridge. A repost collapse can leave the same route on both
 * records while the older keeper still carries the route that was transferred
 * from the repost. In that state redirecting the keeper's copy again is
 * destructive churn, not recovery: the target already has the route.
 */
function jobHasRoute(job, slug) {
  const route = String(slug || '');
  if (!route || !job || typeof job !== 'object') return false;
  if (job.slug === route) return true;
  if (Object.values(job.slugByLocale || {}).includes(route)) return true;
  if (Array.isArray(job.previousSlugs) && job.previousSlugs.includes(route)) return true;
  return Object.values(job.previousSlugsByLocale || {}).some((slugs) => (
    Array.isArray(slugs) && slugs.includes(route)
  ));
}

function normalizedIdentityValue(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Prove that two records are the same source posting under different URLs.
 * The proof is deliberately narrower than a title/company duplicate: it needs
 * the same non-empty source reference, source host, employer identity, full
 * store address, title, place, and body. That is the evidence used by the Coop
 * repost collapse; without it a target-side write followed by a claimant-write
 * failure must still retry.
 */
function jobsShareRepublishedIdentity(left, right) {
  let leftHost = '';
  let rightHost = '';
  try { leftHost = new URL(String(left?.url || '')).hostname.toLowerCase(); } catch { /* no strong URL identity */ }
  try { rightHost = new URL(String(right?.url || '')).hostname.toLowerCase(); } catch { /* no strong URL identity */ }
  if (!leftHost || leftHost !== rightHost) return false;

  const leftSourceReference = left?.sourceReference;
  const rightSourceReference = right?.sourceReference;
  if (typeof leftSourceReference !== 'string'
    || leftSourceReference.trim() === ''
    || leftSourceReference !== rightSourceReference) return false;

  const leftCompanyKey = normalizedIdentityValue(left?.companyKey);
  const rightCompanyKey = normalizedIdentityValue(right?.companyKey);
  if (leftCompanyKey && rightCompanyKey && leftCompanyKey !== rightCompanyKey) return false;

  const leftCompany = normalizedIdentityValue(left?.company || left?.companyKey);
  const rightCompany = normalizedIdentityValue(right?.company || right?.companyKey);
  if (!leftCompany || leftCompany !== rightCompany) return false;

  const requiredFields = ['title', 'description', 'location', 'postalCode', 'streetAddress'];
  return requiredFields.every((field) => {
    const leftValue = normalizedIdentityValue(left?.[field]);
    const rightValue = normalizedIdentityValue(right?.[field]);
    return leftValue !== '' && leftValue === rightValue;
  });
}

/** Build hash → file only when exactly one current record owns that hash. */
export function buildUniqueSuffixOwnerFiles(slices) {
  const owners = new Map();
  for (const { file, jobs } of slices) {
    for (const job of jobs || []) {
      const hash = stableSlugHash(job);
      if (!hash) continue;
      if (!owners.has(hash)) owners.set(hash, []);
      owners.get(hash).push(file);
    }
  }
  return new Map([...owners].filter(([, files]) => files.length === 1).map(([hash, files]) => [hash, files[0]]));
}

/**
 * Build hash → job only when exactly one record in the selected slice owns
 * that hash. A duplicate is deliberately removed instead of letting array
 * order choose a claimant during recovery.
 *
 * @param {Array<object>} jobs
 * @returns {Map<string, object>}
 */
export function buildUniqueSuffixOwnerMap(jobs) {
  const owners = new Map();
  const ambiguous = new Set();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    const hash = stableSlugHash(job);
    if (!hash || ambiguous.has(hash)) continue;
    if (owners.has(hash)) {
      owners.delete(hash);
      ambiguous.add(hash);
      continue;
    }
    owners.set(hash, job);
  }
  return owners;
}

/** Return a confirmed foreign owner file, or null when the tail is absent/ambiguous/local. */
export function resolveForeignRecoveryOwnerFile(file, slug, uniqueOwnerFiles) {
  const match = HASH_TAIL_RE.exec(String(slug || ''));
  if (!match) return null;
  const ownerFile = uniqueOwnerFiles.get(match[1]);
  return ownerFile && ownerFile !== file ? ownerFile : null;
}

function addSourceIdentityKey(keys, value) {
  const identity = String(value || '').replace(/\s+/g, ' ').trim();
  if (identity) keys.add(identity);
}

/**
 * Strong source-posting identities usable by historical recovery.
 *
 * A generated crawler id, title/company tuple, slug hash, or translated text
 * is deliberately not identity proof. Historical rows contribute only their
 * own URL/explicit source identity/reference. Current rows may additionally
 * declare sourceIdentityHistory aliases, because those aliases are the
 * repository's persisted statement that a prior source URL became this
 * posting.
 *
 * @param {object} job
 * @param {{includeHistory?: boolean}} [options]
 * @returns {string[]}
 */
export function recoverySourceIdentityKeys(job = {}, { includeHistory = false } = {}) {
  const keys = new Set();
  const href = sourcePostingUrlHref(job?.url);
  if (href) keys.add(`url:${href}`);
  addSourceIdentityKey(keys, job?.sourceIdentity);

  let host = '';
  try { host = new URL(String(job?.url || '')).hostname.toLowerCase(); } catch { /* no URL-backed reference */ }
  // Source references are opaque provider identifiers: whitespace is cosmetic,
  // but case is part of the identity. Treating `ABC` and `abc` as equal could
  // attach historical evidence to a different posting on the same host.
  const sourceReference = typeof job?.sourceReference === 'string'
    ? job.sourceReference.replace(/\s+/g, ' ').trim()
    : '';
  if (host && sourceReference) keys.add(`reference:${host}:${sourceReference}`);

  if (includeHistory) {
    for (const entry of Array.isArray(job?.sourceIdentityHistory) ? job.sourceIdentityHistory : []) {
      addSourceIdentityKey(keys, entry?.sourceIdentity);
    }
  }
  return [...keys].sort();
}

function addHistoricalRouteEvidence(index, { commit, job, locale, slug, kind }) {
  if (!LOCALES.includes(locale) || !slug) return;
  if (!index.has(slug)) index.set(slug, []);
  const candidate = {
    commit,
    jobKey: resolveJobDiffKey(job),
    kind,
    locale,
    sourceIdentities: recoverySourceIdentityKeys(job),
    revisionCount: 1,
  };
  mergeHistoricalEvidence(index.get(slug), candidate);
}

function historicalEvidenceSignature(evidence) {
  return [
    evidence.kind,
    evidence.locale,
    evidence.jobKey || '',
    ...evidence.sourceIdentities,
  ].join('\u0000');
}

function mergeHistoricalEvidence(evidenceList, candidate) {
  const signature = historicalEvidenceSignature(candidate);
  const existing = evidenceList.find((item) => historicalEvidenceSignature(item) === signature);
  if (!existing) {
    evidenceList.push(candidate);
    return;
  }
  // One canonical revision is enough to prove this exact observation shape;
  // count repeats without retaining up to 400 duplicate objects per slug.
  existing.revisionCount += candidate.revisionCount || 1;
  if (candidate.commit < existing.commit) existing.commit = candidate.commit;
}

/**
 * Index locale-bearing routes observed in explicit Git revisions.
 * Active slugByLocale observations outrank previousSlugsByLocale during plan
 * construction: a later contaminated history bucket cannot override the
 * locale in which the source posting actually served the route.
 *
 * @param {Array<{commit:string,jobs:object[]}>} revisions
 * @returns {Map<string, Array<{commit:string,jobKey:string|null,kind:'active'|'previous',locale:string,sourceIdentities:string[],revisionCount:number}>>}
 */
export function buildRecoveryEvidenceIndex(revisions) {
  const index = new Map();
  for (const revision of Array.isArray(revisions) ? revisions : []) {
    const commit = String(revision?.commit || '').trim();
    if (!commit) continue;
    for (const job of Array.isArray(revision?.jobs) ? revision.jobs : []) {
      for (const [locale, slug] of Object.entries(job?.slugByLocale || {})) {
        addHistoricalRouteEvidence(index, { commit, job, locale, slug, kind: 'active' });
      }
      for (const [locale, slugs] of Object.entries(job?.previousSlugsByLocale || {})) {
        for (const slug of Array.isArray(slugs) ? slugs : []) {
          addHistoricalRouteEvidence(index, { commit, job, locale, slug, kind: 'previous' });
        }
      }
    }
  }
  return index;
}

function buildCurrentSourceIdentityOwners(jobs) {
  const owners = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    for (const identity of recoverySourceIdentityKeys(job, { includeHistory: true })) {
      if (!owners.has(identity)) owners.set(identity, new Set());
      owners.get(identity).add(job);
    }
  }
  return owners;
}

function localeAlreadyServesRoute(job, locale, slug) {
  if (job?.slugByLocale?.[locale] === slug) return true;
  return Array.isArray(job?.previousSlugsByLocale?.[locale])
    && job.previousSlugsByLocale[locale].includes(slug);
}

function rejectedPlanItem(file, inputJobId, slug, reason, extra = {}) {
  return {
    file,
    inputJobId,
    slug,
    decision: 'reject',
    reason,
    ...extra,
  };
}

/**
 * Produce a fail-closed recovery plan for one crawler slice.
 *
 * Every accepted slug must have one historical locale and one current source
 * posting owner across all relevant revisions. Input jobId is provenance only:
 * it may be stale, so it never selects the write target. Ambiguous or missing
 * proof remains visible in the report and causes no mutation.
 */
export function planSliceSlugRecovery({
  file,
  entries,
  currentJobs,
  evidenceBySlug,
  denylist = new Set(),
  uniqueOwnerFiles = new Map(),
  cap = CAP,
}) {
  const identityOwners = buildCurrentSourceIdentityOwners(currentJobs);
  const suffixOwners = buildUniqueSuffixOwnerMap(currentJobs);
  const requests = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const slug of Array.isArray(entry?.slugs) ? entry.slugs : []) {
      requests.push({ inputJobId: String(entry?.jobId || ''), slug: String(slug || '') });
    }
  }
  requests.sort((left, right) => (
    left.inputJobId.localeCompare(right.inputJobId) || left.slug.localeCompare(right.slug)
  ));

  const planned = [];
  for (const { inputJobId, slug } of requests) {
    if (!slug) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'invalid_slug'));
      continue;
    }
    if (denylist.has(denylistKey(file, slug))) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'denylisted'));
      continue;
    }
    const foreignOwnerFile = resolveForeignRecoveryOwnerFile(file, slug, uniqueOwnerFiles);
    if (foreignOwnerFile) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'foreign_current_owner', { foreignOwnerFile }));
      continue;
    }

    const allEvidence = evidenceBySlug.get(slug) || [];
    const activeEvidence = allEvidence.filter((item) => item.kind === 'active');
    const selectedEvidence = activeEvidence.length > 0
      ? activeEvidence
      : allEvidence.filter((item) => item.kind === 'previous');
    if (selectedEvidence.length === 0) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'no_localized_history'));
      continue;
    }

    const evidenceWithIdentity = selectedEvidence.filter((item) => item.sourceIdentities.length > 0);
    if (evidenceWithIdentity.length === 0) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'no_historical_source_identity'));
      continue;
    }

    const evidenceOwners = new Set();
    const matchedIdentities = new Set();
    let identityFailure = null;
    for (const evidence of evidenceWithIdentity) {
      const ownersForEvidence = new Set();
      for (const identity of evidence.sourceIdentities) {
        const owners = identityOwners.get(identity);
        if (!owners) continue;
        for (const owner of owners) ownersForEvidence.add(owner);
        matchedIdentities.add(identity);
      }
      if (ownersForEvidence.size === 0) {
        identityFailure = 'historical_posting_not_current';
        break;
      }
      if (ownersForEvidence.size !== 1) {
        identityFailure = 'ambiguous_current_source_owner';
        break;
      }
      evidenceOwners.add([...ownersForEvidence][0]);
    }
    if (identityFailure) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, identityFailure));
      continue;
    }
    if (evidenceOwners.size !== 1) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'ambiguous_historical_posting'));
      continue;
    }

    const locales = new Set(evidenceWithIdentity.map((item) => item.locale));
    if (locales.size !== 1) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'ambiguous_historical_locale', {
        locales: [...locales].sort(),
      }));
      continue;
    }

    const targetJob = [...evidenceOwners][0];
    const locale = [...locales][0];
    const hashMatch = HASH_TAIL_RE.exec(slug);
    const hashOwner = hashMatch ? suffixOwners.get(hashMatch[1]) : null;
    if (hashOwner && hashOwner !== targetJob) {
      planned.push(rejectedPlanItem(file, inputJobId, slug, 'hash_owner_conflicts_with_source_identity', {
        sourceTargetJobId: resolveJobDiffKey(targetJob),
        hashTargetJobId: resolveJobDiffKey(hashOwner),
      }));
      continue;
    }

    const common = {
      file,
      inputJobId,
      slug,
      targetJobId: resolveJobDiffKey(targetJob),
      locale,
      evidenceKind: activeEvidence.length > 0 ? 'active' : 'previous',
      sourceIdentities: [...matchedIdentities].sort(),
      revisions: [...new Set(evidenceWithIdentity.map((item) => item.commit))].sort(),
      targetJob,
    };
    if (localeAlreadyServesRoute(targetJob, locale, slug)) {
      planned.push({ ...common, decision: 'noop', reason: 'already_present' });
      continue;
    }
    const localeBucket = Array.isArray(targetJob?.previousSlugsByLocale?.[locale])
      ? targetJob.previousSlugsByLocale[locale]
      : [];
    if (localeBucket.length >= cap * RECOVERY_OVERFLOW_MULTIPLIER) {
      planned.push({ ...common, decision: 'reject', reason: 'locale_bucket_full' });
      continue;
    }
    planned.push({ ...common, decision: 'restore', reason: 'unique_historical_proof' });
  }
  return planned;
}

/** Deterministic, mutation-free JSON payload for artifacts and review. */
export function createRecoveryPlanReport(items) {
  const serializable = (Array.isArray(items) ? items : []).map(({ targetJob: _targetJob, ...item }) => item);
  serializable.sort((left, right) => (
    left.file.localeCompare(right.file)
      || left.inputJobId.localeCompare(right.inputJobId)
      || left.slug.localeCompare(right.slug)
  ));
  return {
    version: 1,
    summary: {
      requested: serializable.length,
      restore: serializable.filter((item) => item.decision === 'restore').length,
      noop: serializable.filter((item) => item.decision === 'noop').length,
      rejected: serializable.filter((item) => item.decision === 'reject').length,
    },
    items: serializable,
  };
}

/**
 * A recovered slug's loss event is keyed by a historical `job.id` snapshot,
 * which can be up to 400 commits stale. If that id was ever transiently
 * reused by a different real posting (e.g. across a fingerprint/hash-input
 * change), the "recovered" slug does not actually belong to today's job
 * holding that id — it belongs to whichever job's URL currently hashes to
 * the slug's own disambiguator tail. Cross-check against that before writing.
 *
 * A trailing 6-char lowercase-alnum segment is only trustworthy as a hash
 * signal when it POSITIVELY matches a real, currently-computable job hash
 * (its own, or another job's). Absence of a match is NOT evidence of
 * contamination — plenty of real slug words are coincidentally 6 lowercase
 * letters (e.g. "-campus"), so a tail with no matching owner is left
 * untouched rather than dropped.
 *
 * @param {object} job job currently resolved via the loss event's stale id
 * @param {string} slug slug being recovered
 * @param {Map<string, object>} bySuffixHash stableSlugHash(job) → unambiguous current owner in the selected scope
 * @returns {{ targetJob: object, skip: boolean, redirected: boolean }}
 */
export function resolveRecoveryTarget(job, slug, bySuffixHash) {
  const m = HASH_TAIL_RE.exec(String(slug || ''));
  if (!m) return { targetJob: job, skip: false, redirected: false };
  const tail = m[1];
  const ownHash = stableSlugHash(job);
  if (!ownHash || tail === ownHash) return { targetJob: job, skip: false, redirected: false };
  const owner = bySuffixHash.get(tail);
  if (owner && owner !== job) {
    // The route is already reachable from the hash owner and both records are
    // proven copies of the same source posting. This occurs when a repost was
    // collapsed into an older keeper but both current records still retain the
    // transferred bridge. Removing the keeper copy would lose locale
    // attribution and cannot improve ownership, while repeatedly planning the
    // same move keeps the live-data observer red. A target-only route is not
    // enough: an interrupted target-first write must still converge on retry.
    if (jobHasRoute(owner, slug) && jobsShareRepublishedIdentity(job, owner)) {
      return { targetJob: job, skip: false, redirected: false };
    }
    return { targetJob: owner, skip: false, redirected: true };
  }
  return { targetJob: job, skip: false, redirected: false };
}

/**
 * Write a single recovered slug onto its target job with bounded overflow.
 *
 * Recovered slugs are, by definition, the OLDEST entries a job ever had
 * (they were captured long enough ago to have since fallen off history) —
 * never the newest. Pushing them onto the tail and then cap-trimming the
 * front (the pattern addPreviousSlugForLocale uses for live, chronologically
 * -ordered captures) would silently evict whatever is CURRENTLY in the
 * bucket to make room for these stale entries, i.e. recovery would
 * manufacture brand-new losses of live slugs on every run — the exact
 * oscillation that kept this workflow's own "Recover N previousSlugs"
 * commits showing up as the top offending commits in the next scan (#3587).
 * Recovery stays non-destructive (see recover-prev-slugs.yml header: "Recovery
 * is non-destructive — only ADDS"): it never evicts a live entry. A proven
 * recovery may use one additional cap-sized window, but once that bounded
 * headroom is full the slug is skipped. Recovered entries are prepended
 * because they are older than the live history; a later normal writer that
 * applies the ordinary cap therefore drops recovery overflow before current
 * entries.
 *
 * The flat legacy array is a union of the locale buckets, so it receives the
 * same bounded headroom over its established `cap * LOCALES.length` limit.
 *
 * @param {object} targetJob – job to mutate in place.
 * @param {string} locale – locale bucket the slug is attributed to.
 * @param {string} slug – recovered slug value.
 * @param {number} [cap=CAP] – normal per-locale bucket cap; recovery can use
 * one additional cap-sized window, and the flat legacy cap is multiplied by
 * the number of supported locales.
 * @returns {{ restored: boolean, skippedAtCap: boolean }}
 */
export function applyRecoveredSlug(targetJob, locale, slug, cap = CAP) {
  if (!targetJob.previousSlugsByLocale || typeof targetJob.previousSlugsByLocale !== 'object') {
    targetJob.previousSlugsByLocale = {};
  }
  if (!Array.isArray(targetJob.previousSlugsByLocale[locale])) {
    targetJob.previousSlugsByLocale[locale] = [];
  }

  let restored = false;
  const skippedAtCap = false;
  const localeBucket = targetJob.previousSlugsByLocale[locale];
  const recoveryBucketCap = cap * RECOVERY_OVERFLOW_MULTIPLIER;
  if (!localeBucket.includes(slug)) {
    if (localeBucket.length >= recoveryBucketCap) {
      return { restored: false, skippedAtCap: true };
    }
    // Recovered values are older than the current live history. Put them at
    // the front so a future ordinary cap-trim removes these values first.
    localeBucket.unshift(slug);
    restored = true;
  }

  // Also sync flat previousSlugs for legacy consumers. It has one bucket-sized
  // window per supported locale, matching the normal legacy union cap, plus
  // the same bounded recovery headroom.
  if (!Array.isArray(targetJob.previousSlugs)) targetJob.previousSlugs = [];
  const recoveryLegacyCap = cap * LOCALES.length * RECOVERY_OVERFLOW_MULTIPLIER;
  if (!targetJob.previousSlugs.includes(slug) && targetJob.previousSlugs.length < recoveryLegacyCap) {
    targetJob.previousSlugs.unshift(slug);
    restored = true;
  }

  return { restored, skippedAtCap };
}

// One-shot cache of file → slug evidence built lazily. Subsequent recovery
// requests in the same file reuse one bounded history walk.
const _fileRecoveryEvidenceCache = new Map();

/**
 * Build an index for ALL jobs in one slice file in a single pass over
 * the file's git history. Per-job lookup becomes O(1) afterwards.
 *
 * Root cause of issue #5025: this used to spawn a fresh `execSync('git show
 * <commit>:<path>')` process per historical blob (up to `maxCommits` per
 * file) — the exact per-blob-subprocess anti-pattern already identified and
 * fixed in scripts/scan-prev-slug-losses.mjs (issue #4654) via a long-lived
 * `git cat-file --batch` process, but never carried over to this sibling
 * script. With the scan step's own bottleneck fixed, this became the new
 * dominant cost (coop-ticino.json's 352 jobs alone took 3+ minutes),
 * cancelling the scheduled job mid-run. Reuses the SAME shared batch process
 * (scripts/lib/git-cat-file-batch.mjs) across every file instead of spawning
 * one per historical blob.
 *
 * @param {string} file absolute path to the slice file
 * @param {ReturnType<typeof createCatFileBatch>} catFile shared batch process
 * @param {number} [maxCommits=400] cap on history walked (newest first)
 * @returns {Promise<Map<string, Array<object>>>} slug → historical proof
 */
async function buildFileRecoveryEvidence(file, catFile, maxCommits = 400) {
  if (_fileRecoveryEvidenceCache.has(file)) return _fileRecoveryEvidenceCache.get(file);
  const rel = path.relative(ROOT, file);
  let commits;
  try {
    commits = execFileSync(
      'git',
      ['log', '--pretty=format:%H', '-n', String(maxCommits), '--', rel],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, cwd: ROOT },
    ).trim().split('\n').filter(Boolean);
  } catch {
    const empty = new Map();
    _fileRecoveryEvidenceCache.set(file, empty);
    return empty;
  }
  const evidenceBySlug = new Map();
  for (const commit of commits) {
    const content = await catFile.get(`${commit}:${rel}`);
    if (content == null) continue;
    let parsed;
    try { parsed = JSON.parse(content); } catch { continue; }
    if (!Array.isArray(parsed?.jobs)) continue;
    const revisionEvidence = buildRecoveryEvidenceIndex([{ commit, jobs: parsed.jobs }]);
    for (const [slug, evidence] of revisionEvidence) {
      if (!evidenceBySlug.has(slug)) evidenceBySlug.set(slug, []);
      for (const candidate of evidence) mergeHistoricalEvidence(evidenceBySlug.get(slug), candidate);
    }
  }
  _fileRecoveryEvidenceCache.set(file, evidenceBySlug);
  return evidenceBySlug;
}

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');
  const inputIdx = args.indexOf('--input');
  const INPUT = inputIdx !== -1 ? args[inputIdx + 1] : '/tmp/recoverable-slugs.json';
  const reportIdx = args.indexOf('--report');
  const inputParts = path.parse(INPUT);
  const REPORT = reportIdx !== -1
    ? args[reportIdx + 1]
    : path.join(inputParts.dir, `${inputParts.name}.recovery-plan.json`);

  if (!INPUT || !REPORT) {
    console.error('❌ --input and --report require a path value');
    process.exit(2);
  }

  if (!fs.existsSync(INPUT)) {
    console.error(`❌ Input not found: ${INPUT}`);
    console.error('Run scripts/scan-prev-slug-losses-fast.mjs first to generate it.');
    process.exit(2);
  }

  const rawRecoverList = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  if (!Array.isArray(rawRecoverList)) {
    throw new Error(`Recovery input must be an array: ${INPUT}`);
  }
  console.log(`📥 Loaded ${rawRecoverList.length} jobs with recoverable slugs from ${INPUT}`);

  // The denylist is evaluated inside the plan so every refusal remains in the
  // deterministic report instead of disappearing before attribution.
  const denylist = loadRestoreDenylist();

  const stats = {
    filesUpdated: 0,
    jobsUpdated: 0,
    slugsRestored: 0,
  };
  const filesByName = new Map();
  for (const entry of rawRecoverList) {
    if (!filesByName.has(entry.file)) filesByName.set(entry.file, []);
    filesByName.get(entry.file).push(entry);
  }

  // Recovery events are grouped by their historical claimant file, but a
  // hash-tagged slug may now have a unique owner in another crawler slice.
  // This writer cannot atomically mutate two live slices. Fail closed instead
  // of re-contaminating the claimant: the post-recovery scan keeps the loss
  // visible until the fleet-wide decontamination surface can re-home it.
  const currentSlices = fs.readdirSync(BY_CRAWLER_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const slice = JSON.parse(fs.readFileSync(path.join(BY_CRAWLER_DIR, file), 'utf8'));
      return { file, jobs: Array.isArray(slice.jobs) ? slice.jobs : [] };
    });
  const uniqueOwnerFiles = buildUniqueSuffixOwnerFiles(currentSlices);

  // Shared long-lived `git cat-file --batch` process (see
  // scripts/lib/git-cat-file-batch.mjs) — ONE process serves every historical
  // blob lookup across every file below instead of one subprocess per commit.
  const catFile = createCatFileBatch(ROOT);
  const planItems = [];

  let fileCount = 0;
  try {
    for (const file of [...filesByName.keys()].sort()) {
      const entries = filesByName.get(file);
      fileCount++;
      const filePath = path.join(BY_CRAWLER_DIR, file);
      if (path.basename(file) !== file || !file.endsWith('.json') || !fs.existsSync(filePath)) {
        console.warn(`  ⚠️  Skip ${file} (not a valid slice basename)`);
        for (const entry of entries) {
          for (const slug of Array.isArray(entry?.slugs) ? entry.slugs : []) {
            planItems.push(rejectedPlanItem(file, String(entry?.jobId || ''), String(slug || ''), 'slice_missing'));
          }
        }
        continue;
      }
      process.stderr.write(`  [${fileCount}/${filesByName.size}] ${file} (${entries.length} jobs)\n`);
      const slice = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(slice?.jobs)) {
        throw new Error(`Invalid active slice shape: ${file}`);
      }

      const evidenceBySlug = await buildFileRecoveryEvidence(filePath, catFile);
      const filePlan = planSliceSlugRecovery({
        file,
        entries,
        currentJobs: slice.jobs,
        evidenceBySlug,
        denylist,
        uniqueOwnerFiles,
      });
      planItems.push(...filePlan);

      const changedJobIds = new Set();
      for (const item of filePlan) {
        if (item.decision !== 'restore') continue;
        const { restored } = applyRecoveredSlug(item.targetJob, item.locale, item.slug, CAP);
        if (restored) {
          changedJobIds.add(item.targetJobId);
          stats.slugsRestored++;
        }
      }
      stats.jobsUpdated += changedJobIds.size;

      if (changedJobIds.size > 0) {
        if (!DRY_RUN) writeJsonAtomic(filePath, slice);
        stats.filesUpdated++;
      }
    }
  } finally {
    catFile.close();
  }

  const report = createRecoveryPlanReport(planItems);
  writeJsonAtomic(REPORT, report);
  const denylistSkipped = report.items.filter((item) => item.reason === 'denylisted').length;

  console.log('\n📊 Backfill complete:');
  console.log(`  files updated:               ${stats.filesUpdated}${DRY_RUN ? ' (dry-run, no writes)' : ''}`);
  console.log(`  jobs updated:                ${stats.jobsUpdated}`);
  console.log(`  slugs restored (proven):     ${stats.slugsRestored}`);
  console.log(`  slugs already present:       ${report.summary.noop}`);
  console.log(`  slugs rejected (no proof):   ${report.summary.rejected}`);
  console.log(`  slugs skipped (denylisted):  ${denylistSkipped}`);
  console.log(`  recovery plan:               ${REPORT}`);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

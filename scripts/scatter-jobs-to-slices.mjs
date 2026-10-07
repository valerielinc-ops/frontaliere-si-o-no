#!/usr/bin/env node
/**
 * scatter-jobs-to-slices.mjs
 *
 * Reads the assembled data/jobs.json and writes updated jobs back to their
 * per-crawler slice files (data/jobs/by-crawler/{key}.json).
 *
 * Use case: After a script modifies the assembled data/jobs.json (e.g.
 * relocalize-pending-jobs.mjs), this script propagates changes back to
 * the per-crawler slices so they can be committed.
 *
 * Only updates slices where job data actually changed.
 */

import fs from 'node:fs';
import { listSliceFileNames } from './lib/crawler-slice-files.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { addPreviousSlugForLocale, promotePreviousSlugToLegacy, restoreLocaleSlug, DEFAULT_PREV_SLUG_CAP, LEGACY_PREV_SLUGS_CAP, LOCALES, stableSlugHash } from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId, resolveJobDiffKey } from './lib/job-match-key.mjs';
import { localeMapsEqual } from './lib/locale-map-diff.mjs';
import { resolveRecoveryTarget } from './backfill-prev-slugs-from-loss-events.mjs';
import { decontaminateEntries, decontaminateJobs } from './decontaminate-prev-slugs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.join(ROOT, 'data', 'jobs.json');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

function normalizedJobUrl(job) {
  return String(job?.url || '').trim().toLowerCase();
}

function stableUrlIndexKey(url) {
  const stableUrl = extractStableJobId(url);
  if (!stableUrl) return '';

  // The stable token is intentionally generic (for example `num:106683`),
  // so it is not a cross-site identity. STA and Stellenpartner can expose
  // different postings with the same numeric suffix. Keep the token useful
  // for path/slug changes, but namespace it by the URL host first.
  // An input `new URL()` rejects (protocol-relative, malformed) has no host to
  // scope the token with: return no stable key instead of an unscoped one, so
  // the match falls through to the exact-URL and diff-key checks.
  try {
    const host = new URL(url).host.toLowerCase();
    return host ? `${host}|${stableUrl}` : '';
  } catch {
    return '';
  }
}

function addToIndex(index, key, job) {
  if (!key) return;
  const entries = index.get(key);
  if (entries) entries.push(job);
  else index.set(key, [job]);
}

function uniqueIndexEntry(index, key) {
  if (!key || !index.has(key)) return { found: false, job: null };
  const entries = index.get(key);
  return { found: true, job: entries.length === 1 ? entries[0] : null };
}

function sliceEntryJobs(entry) {
  if (Array.isArray(entry?.jobs)) return entry.jobs;
  if (Array.isArray(entry?.slice?.jobs)) return entry.slice.jobs;
  return [];
}

function buildSliceOwnershipIndex(sliceEntries) {
  const entries = (Array.isArray(sliceEntries) ? sliceEntries : [])
    .filter((entry) => sliceEntryJobs(entry).length > 0);
  const globalOwners = new Map();
  for (const entry of entries) {
    for (const job of sliceEntryJobs(entry)) {
      const hash = stableSlugHash(job);
      if (!hash) continue;
      if (!globalOwners.has(hash)) globalOwners.set(hash, []);
      globalOwners.get(hash).push(job);
    }
  }

  const globallyUnique = new Map(
    [...globalOwners]
      .filter(([, jobs]) => jobs.length === 1)
      .map(([hash, jobs]) => [hash, jobs[0]]),
  );
  const ownersByEntry = new Map();
  for (const entry of entries) {
    const owners = new Map(globallyUnique);
    const sameSliceOwners = new Map();
    const sameSliceAmbiguous = new Set();
    for (const job of sliceEntryJobs(entry)) {
      const hash = stableSlugHash(job);
      if (!hash || sameSliceAmbiguous.has(hash)) continue;
      if (sameSliceOwners.has(hash)) {
        sameSliceOwners.delete(hash);
        sameSliceAmbiguous.add(hash);
        continue;
      }
      sameSliceOwners.set(hash, job);
    }
    for (const [hash, job] of sameSliceOwners) owners.set(hash, job);
    ownersByEntry.set(entry, owners);
  }
  return { entries, ownersByEntry };
}

function targetAlreadyServesBridge(job, assembled, slug) {
  const value = String(slug || '');
  if (!value || !job || typeof job !== 'object') return false;
  if (String(job.slug || '') === value) return true;
  if (Object.values(job.slugByLocale || {}).some((active) => String(active || '') === value)) return true;

  const attributedLocales = Object.entries(assembled?.previousSlugsByLocale || {})
    .filter(([, slugs]) => (Array.isArray(slugs) ? slugs : []).includes(value))
    .map(([locale]) => locale);
  if (attributedLocales.length > 0) {
    return (Array.isArray(job.previousSlugs) ? job.previousSlugs : []).includes(value)
      && attributedLocales.every((locale) => (
        Array.isArray(job.previousSlugsByLocale?.[locale])
        && job.previousSlugsByLocale[locale].includes(value)
      ));
  }
  return (Array.isArray(job.previousSlugs) ? job.previousSlugs : []).includes(value);
}

function assembledBridgeSlugs(assembled) {
  const slugs = new Set();
  for (const slug of (Array.isArray(assembled?.previousSlugs) ? assembled.previousSlugs : [])) {
    const value = String(slug || '');
    if (value) slugs.add(value);
  }
  for (const values of Object.values(assembled?.previousSlugsByLocale || {})) {
    for (const slug of (Array.isArray(values) ? values : [])) {
      const value = String(slug || '');
      if (value) slugs.add(value);
    }
  }
  return slugs;
}

function bridgesOwnedByAnotherSlice(sliceJob, entry, assembled, ownership) {
  const owners = ownership?.ownersByEntry?.get(entry);
  if (!owners) return new Set();
  const owned = new Set();
  for (const slug of assembledBridgeSlugs(assembled)) {
    const { targetJob, redirected } = resolveRecoveryTarget(sliceJob, slug, owners);
    if (redirected && targetJob !== sliceJob && targetAlreadyServesBridge(targetJob, assembled, slug)) owned.add(slug);
  }
  return owned;
}

/**
 * Build the assembled-job indexes used by the assembled→slice writer.
 *
 * `assemble-jobs-dataset.mjs` stamps a synthetic `.id` on records that did
 * not have one in their crawler slice. An index keyed only by
 * `resolveJobDiffKey()` therefore misses the same record on the slice side:
 * the assembled record resolves to its synthetic id while the slice resolves
 * to its URL. URL identity is the strongest join key here, followed by the
 * host-scoped stable URL token and only then the generic diff key. Every index retains
 * ambiguity instead of silently choosing a sibling.
 *
 * @param {Array<object>} assembledJobs
 * @returns {{byUrl: Map<string, object[]>, byStableUrl: Map<string, object[]>, byDiffKey: Map<string, object[]>}}
 */
export function buildAssembledJobIndex(assembledJobs) {
  const index = {
    byUrl: new Map(),
    byStableUrl: new Map(),
    byDiffKey: new Map(),
  };
  for (const job of Array.isArray(assembledJobs) ? assembledJobs : []) {
    const url = normalizedJobUrl(job);
    if (url) {
      addToIndex(index.byUrl, url, job);
      const stableUrl = stableUrlIndexKey(url);
      if (stableUrl) addToIndex(index.byStableUrl, stableUrl, job);
    }
    addToIndex(index.byDiffKey, resolveJobDiffKey(job), job);
  }
  return index;
}

/**
 * Match one per-crawler slice job to its assembled counterpart.
 *
 * URL identity wins over the assembled-only synthetic id. A stable URL token
 * handles URL decoration changes, while the generic diff key remains the
 * final fallback for records with no usable URL. Ambiguous indexes and
 * contradictory URL identities are rejected: assigning a translation or SEO
 * bridge to a sibling is worse than leaving that record for a later run.
 *
 * @param {object} sliceJob
 * @param {{byUrl: Map<string, object[]>, byStableUrl: Map<string, object[]>, byDiffKey: Map<string, object[]>}} index
 * @returns {object|null}
 */
export function matchAssembledJob(sliceJob, index) {
  const sliceUrl = normalizedJobUrl(sliceJob);
  const exact = uniqueIndexEntry(index?.byUrl, sliceUrl);
  if (exact.found) {
    const byDiffKey = uniqueIndexEntry(index?.byDiffKey, resolveJobDiffKey(sliceJob));
    if (!exact.job || (byDiffKey.found && byDiffKey.job !== exact.job)) return null;
    return exact.job;
  }

  const stableUrl = stableUrlIndexKey(sliceUrl);
  const stable = uniqueIndexEntry(index?.byStableUrl, stableUrl);
  if (stable.found) {
    const byDiffKey = uniqueIndexEntry(index?.byDiffKey, resolveJobDiffKey(sliceJob));
    if (!stable.job || (byDiffKey.found && byDiffKey.job !== stable.job)) return null;
    return stable.job;
  }

  const byDiffKey = uniqueIndexEntry(index?.byDiffKey, resolveJobDiffKey(sliceJob));
  if (!byDiffKey.found || !byDiffKey.job) return null;

  const assembledUrl = normalizedJobUrl(byDiffKey.job);
  if (sliceUrl && assembledUrl) {
    const assembledStableUrl = stableUrlIndexKey(assembledUrl);
    if (sliceUrl !== assembledUrl && (!stableUrl || stableUrl !== assembledStableUrl)) return null;
  }
  return byDiffKey.job;
}

/**
 * Verify the assembled→slice contract after a scatter run.
 *
 * The assembled dataset is the population that must be represented in the
 * committed active slices. Slice-only records are allowed because assembly
 * may deduplicate or filter them, but an assembled record that cannot be
 * matched, an ambiguous slice identity, a genuinely missing bridge, an
 * active-locale slug mismatch, or a second pending write is a real parity
 * failure. A bridge already served by the unique owner selected by the slice
 * decontamination rules is not genuinely missing from the projection.
 *
 * @param {Array<object>} assembledJobs
 * @param {Array<{file?: string, jobs: Array<object>}>} sliceEntries
 * @returns {object}
 */
export function verifyScatterParity(assembledJobs, sliceEntries) {
  const jobs = Array.isArray(assembledJobs) ? assembledJobs : [];
  const index = buildAssembledJobIndex(jobs);
  const ownership = buildSliceOwnershipIndex(sliceEntries);
  const assembledKeys = new Set();
  let duplicateAssembledKeys = 0;
  let unkeyedAssembledJobs = 0;
  for (const job of jobs) {
    const key = resolveJobDiffKey(job);
    if (!key) {
      unkeyedAssembledJobs++;
      continue;
    }
    if (assembledKeys.has(key)) duplicateAssembledKeys++;
    assembledKeys.add(key);
  }

  const matchedKeys = new Set();
  const assembledMatchCounts = new Map();
  const sliceKeys = new Set();
  let duplicateSliceKeys = 0;
  let duplicateAssembledMatches = 0;
  let sliceJobs = 0;
  let unmatchedSliceJobs = 0;
  let missingBridges = 0;
  let pendingWrites = 0;
  let activeSlugMismatches = 0;

  for (const entry of Array.isArray(sliceEntries) ? sliceEntries : []) {
    for (const sliceJob of sliceEntryJobs(entry)) {
      sliceJobs++;
      const sliceKey = resolveJobDiffKey(sliceJob);
      if (sliceKey && sliceKeys.has(sliceKey)) duplicateSliceKeys++;
      if (sliceKey) sliceKeys.add(sliceKey);

      const assembled = matchAssembledJob(sliceJob, index);
      if (!assembled) {
        unmatchedSliceJobs++;
        continue;
      }
      const matchCount = (assembledMatchCounts.get(assembled) || 0) + 1;
      assembledMatchCounts.set(assembled, matchCount);
      if (matchCount > 1) duplicateAssembledMatches++;
      matchedKeys.add(resolveJobDiffKey(assembled));
      const skipBridges = bridgesOwnedByAnotherSlice(sliceJob, entry, assembled, ownership);
      missingBridges += collectMissingAssembledBridges(sliceJob, assembled, { skipBridges }).length;
      if (applyAssembledToSliceJob(sliceJob, assembled, { skipBridges }).changed) pendingWrites++;

      const effectiveSlugs = mergeLocaleMap(sliceJob.slugByLocale, assembled.slugByLocale);
      if (!localeMapsEqual(effectiveSlugs, sliceJob.slugByLocale)) activeSlugMismatches++;
    }
  }

  const report = {
    assembledJobs: jobs.length,
    uniqueAssembledJobs: assembledKeys.size,
    matchedAssembledJobs: matchedKeys.size,
    missingAssembledJobs: unkeyedAssembledJobs + [...assembledKeys].filter((key) => !matchedKeys.has(key)).length,
    unkeyedAssembledJobs,
    duplicateAssembledKeys,
    sliceJobs,
    unmatchedSliceJobs,
    duplicateSliceKeys,
    duplicateAssembledMatches,
    missingBridges,
    pendingWrites,
    activeSlugMismatches,
  };
  report.passed = report.missingAssembledJobs === 0
    && report.unkeyedAssembledJobs === 0
    && report.duplicateAssembledKeys === 0
    && report.duplicateSliceKeys === 0
    && report.duplicateAssembledMatches === 0
    && report.missingBridges === 0
    && report.pendingWrites === 0
    && report.activeSlugMismatches === 0;
  return report;
}

function readSliceFileEntries(directory) {
  return listSliceFileNames(directory).flatMap((file) => {
    const filePath = path.join(directory, file);
    const slice = readJson(filePath, null);
    return slice && Array.isArray(slice.jobs) ? [{ file, filePath, slice }] : [];
  });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Merge two locale maps. For each locale, prefer the assembled value if non-empty,
 * otherwise keep the slice value. This prevents AI translation failures from
 * destroying existing translations.
 */
export function mergeLocaleMap(sliceMap, assembledMap) {
  const s = (sliceMap && typeof sliceMap === 'object') ? sliceMap : {};
  const a = (assembledMap && typeof assembledMap === 'object') ? assembledMap : {};
  const merged = { ...s };
  for (const [locale, value] of Object.entries(a)) {
    const trimmed = String(value || '').trim();
    const existing = String(merged[locale] || '').trim();
    // Only update if assembled has a non-empty value, OR if slice also has nothing
    if (trimmed) {
      // Assembled has content — use it (it may be a real translation)
      merged[locale] = value;
    }
    // If assembled is empty but slice has content, keep slice (don't destroy)
  }
  return merged;
}

/**
 * Collect every slug the ASSEMBLED job already knows about as a previousSlugs
 * bridge (flat legacy array + per-locale buckets) that is NOT yet present
 * anywhere on the slice job's active-or-history slug set. These are SEO
 * redirect bridges the assembled pipeline captured (via
 * assemble-jobs-dataset's trackSlugHistoryDrift / ensureLocaleFields) but
 * that the per-crawler slice — the committed
 * source of truth the build plugin reads to emit bridge pages — is missing.
 *
 * Scatter is the assembled→slice writer for every job NOT touched by
 * relocalize-pending-jobs.mjs; relocalize already carries these bridges
 * forward (see its "Sync previousSlugs from assembled dataset" block), so
 * scatter dropping them was the sibling gap that silently lost bridges for
 * the non-pending majority of jobs (issue class #4165/#4161/#4134/#4112/
 * #4102/#4088/#4076/#3885).
 *
 * Bounded by the flat legacy cap (LEGACY_PREV_SLUGS_CAP): only as many NEW
 * distinct bridges are returned as fit under the cap alongside the slice's
 * existing history, so carrying them forward can NEVER evict a slug the slice
 * already had (the flat array is the widest cap and the only bucket whose
 * eviction shows up as a scan-detected loss — per-locale eviction stays
 * mirrored in the flat union). Attributed (per-locale) bridges are preferred
 * over unattributed flat-only ones when headroom is scarce, since correct
 * locale attribution drives which prefix the bridge page is emitted under.
 *
 * @param {{skipBridges?: Set<string>}} [options]
 * @returns {Array<{ locale: string|null, slug: string }>} ordered add-list
 */
export function collectMissingAssembledBridges(sliceJob, assembled, { skipBridges = new Set() } = {}) {
  const known = new Set();
  if (sliceJob.slug) known.add(String(sliceJob.slug));
  for (const s of Object.values(sliceJob.slugByLocale || {})) if (s) known.add(String(s));
  for (const s of (Array.isArray(sliceJob.previousSlugs) ? sliceJob.previousSlugs : [])) if (s) known.add(String(s));
  const existingByLocale = (sliceJob.previousSlugsByLocale && typeof sliceJob.previousSlugsByLocale === 'object')
    ? sliceJob.previousSlugsByLocale : {};
  for (const arr of Object.values(existingByLocale)) {
    for (const s of (Array.isArray(arr) ? arr : [])) if (s) known.add(String(s));
  }

  // Headroom under the flat legacy cap: adding more distinct bridges than this
  // would push the flat union past the cap and trim the oldest (possibly a
  // pre-existing slice entry). `known` already deduplicates every slug the
  // job currently holds anywhere, so its size is exactly the flat union size.
  const headroom = Math.max(0, LEGACY_PREV_SLUGS_CAP - known.size);
  if (headroom === 0) return [];

  // `addPreviousSlugForLocale` also caps each locale bucket at 20. A flat
  // union can still have room while a particular locale bucket is full; in
  // that case adding a missing attributed bridge would evict an older slice
  // bridge and make every subsequent run rotate the same capped set. Preserve
  // the committed bucket and fall back to the wider, provenance-unknown flat
  // bridge instead. This keeps the URL reachable without inventing a
  // locale-bucket eviction.
  const localeHeadroom = new Map(LOCALES.map((locale) => {
    const bucket = Array.isArray(existingByLocale[locale]) ? existingByLocale[locale] : [];
    return [locale, Math.max(0, DEFAULT_PREV_SLUG_CAP - bucket.length)];
  }));

  // Pass 1 (preferred): locale-attributed bridges. A value already present in
  // the flat array but missing from THIS locale's bucket still counts as new
  // for the bucket (bridge emission routes through the bucket preferentially),
  // but it is NOT new for the flat union, so it does not consume headroom.
  const adds = [];
  const seen = new Set();
  if (assembled.previousSlugsByLocale && typeof assembled.previousSlugsByLocale === 'object') {
    for (const locale of LOCALES) {
      const arr = assembled.previousSlugsByLocale[locale];
      if (!Array.isArray(arr)) continue;
      const bucket = Array.isArray(existingByLocale[locale]) ? existingByLocale[locale] : [];
      for (const s of arr) {
        const v = String(s || '');
        if (!v || bucket.includes(v) || skipBridges.has(v)) continue;
        const dedupKey = `${locale} ${v}`;
        if (seen.has(dedupKey)) continue;
        const consumesHeadroom = !known.has(v);
        if (consumesHeadroom && adds.filter((a) => !a._free).length >= headroom) continue;
        const hasLocaleRoom = (localeHeadroom.get(locale) || 0) > 0;
        if (!hasLocaleRoom && !consumesHeadroom) continue;
        seen.add(dedupKey);
        adds.push({ locale: hasLocaleRoom ? locale : null, slug: v, _free: !consumesHeadroom });
        if (hasLocaleRoom) localeHeadroom.set(locale, localeHeadroom.get(locale) - 1);
        if (consumesHeadroom) known.add(v);
      }
    }
  }
  // Pass 2: unattributed flat-only bridges → default to the IT bucket, only up
  // to remaining headroom. If IT is full, preserve the bridge in the flat
  // legacy field rather than rotating a committed locale bucket.
  for (const s of (Array.isArray(assembled.previousSlugs) ? assembled.previousSlugs : [])) {
    const v = String(s || '');
    if (!v || known.has(v) || skipBridges.has(v)) continue;
    if (adds.filter((a) => !a._free).length >= headroom) break;
    known.add(v);
    const hasItRoom = (localeHeadroom.get('it') || 0) > 0;
    adds.push({ locale: hasItRoom ? 'it' : null, slug: v, _free: false });
    if (hasItRoom) localeHeadroom.set('it', localeHeadroom.get('it') - 1);
  }
  return adds.map(({ locale, slug }) => ({ locale, slug }));
}

/**
 * Apply an assembled job's translated locale fields + captured slug history
 * onto its per-crawler slice job. Pure: returns a NEW job object (never
 * mutates the input) plus whether anything changed. Unit-tested directly.
 *
 * @param {object} sliceJob  the per-crawler slice job (source of truth)
 * @param {object} assembled the matching assembled data/jobs.json entry
 * @param {{skipBridges?: Set<string>}} [options]
 * @returns {{ job: object, changed: boolean }}
 */
export function applyAssembledToSliceJob(sliceJob, assembled, { skipBridges = new Set() } = {}) {
  // SEO bridge slugs the assembled job captured (trackSlugHistoryDrift /
  // ensureLocaleFields) but the slice is still missing.
  // Computed up front (on the PRE-rename sliceJob) purely to decide whether a
  // job whose locale/slug fields are otherwise unchanged still needs a write
  // — otherwise a slug renamed on the assembled side in a prior run (its old
  // value living only in the assembled previousSlugs) would never make it
  // onto the committed slice. This preliminary list is NOT used for the
  // actual carry-forward below (see the recompute after the rename loop,
  // issue #4208) — it is only safe as a boolean "is there anything to add"
  // gate here because whenever THIS call also renames a slug, `changed`
  // already flips true via the slugByLocale diff check two lines down,
  // independent of this list's headroom accuracy.
  const hasMissingBridgesPreRename = collectMissingAssembledBridges(sliceJob, assembled, { skipBridges }).length > 0;

  // Compare the effective locale projection — only update if the assembled
  // values would change what the slice serves. `mergeLocaleMap()` deliberately
  // keeps a non-empty slice value when the assembled value is empty, so compare
  // after that defensive merge rather than treating a preserved value as drift.
  // Field-by-field via `localeMapsEqual`, NOT `JSON.stringify` (follow-up
  // #7492): the two sides can build maps in different key orders.
  const mergedTitle = mergeLocaleMap(sliceJob.titleByLocale, assembled.titleByLocale);
  const mergedDesc = mergeLocaleMap(sliceJob.descriptionByLocale, assembled.descriptionByLocale);
  const mergedSlug = mergeLocaleMap(sliceJob.slugByLocale, assembled.slugByLocale);
  const changed =
    !localeMapsEqual(mergedTitle, sliceJob.titleByLocale) ||
    !localeMapsEqual(mergedDesc, sliceJob.descriptionByLocale) ||
    !localeMapsEqual(mergedSlug, sliceJob.slugByLocale) ||
    hasMissingBridgesPreRename;

  if (!changed) return { job: sliceJob, changed: false };

  // Defensive merge: never overwrite a non-empty locale value with an empty one.
  // The assembled data may have had locales stripped by ensureLocaleFields when
  // AI translation failed — the per-crawler file is the source of truth.
  // Track slug changes: preserve old slug values in previousSlugsByLocale so the build
  // plugin can generate bridge/redirect pages for SEO continuity (prevents 404s
  // for URLs that Google/Bing may have already indexed).
  const oldSlugs = sliceJob.slugByLocale && typeof sliceJob.slugByLocale === 'object'
    ? sliceJob.slugByLocale : {};
  const newSlugs = mergedSlug && typeof mergedSlug === 'object' ? mergedSlug : {};

  const updatedJob = {
    ...sliceJob,
    previousSlugs: Array.isArray(sliceJob.previousSlugs) ? [...sliceJob.previousSlugs] : sliceJob.previousSlugs,
    previousSlugsByLocale: sliceJob.previousSlugsByLocale && typeof sliceJob.previousSlugsByLocale === 'object'
      ? Object.fromEntries(Object.entries(sliceJob.previousSlugsByLocale).map(([locale, slugs]) => [locale, Array.isArray(slugs) ? [...slugs] : slugs]))
      : sliceJob.previousSlugsByLocale,
    titleByLocale: mergedTitle,
    descriptionByLocale: mergedDesc,
    slugByLocale: mergedSlug,
  };

  // Detect per-locale slug changes and record with locale context.
  // Route through the canonical journal-backed helper (instead of a
  // hand-rolled push + flat-array cap) so every capture/cap-trim is
  // recorded via recordSlugMutation like every other slug-mutation path
  // (previousSlugs regression: issue #3284 — this call site pushed into
  // previousSlugsByLocale and re-derived the legacy `previousSlugs`
  // mirror with its own `.slice(0, 20)` that kept the OLDEST 20 entries
  // instead of the most recent ones, with no journal entry for the trim).
  const locales = ['it', 'en', 'de', 'fr'];
  for (const locale of locales) {
    const oldSlug = String(oldSlugs[locale] || '').trim();
    const newSlug = String(newSlugs[locale] || '').trim();

    // Live slug, empty replacement: the merged map lost this locale. The
    // `oldSlug && newSlug &&` condition below skips the capture in exactly
    // this case, so `updatedJob.slugByLocale[locale]` would go blank and take
    // an already-indexed URL down with it, with no journal entry — the #5157
    // failure mode. Keep serving the existing slug until a real replacement
    // exists (same rule as mergePreserveLocaleData in
    // scripts/lib/dedicated-crawler-common.mjs).
    if (oldSlug && !newSlug) {
      restoreLocaleSlug(updatedJob, locale, oldSlug, 'scatter-jobs-to-slices/empty-replacement');
      continue;
    }

    if (oldSlug && newSlug && oldSlug !== newSlug) {
      addPreviousSlugForLocale(updatedJob, locale, oldSlug, 20, 'scatter-jobs-to-slices');
    }
  }

  // Carry forward SEO bridge slugs the assembled dataset already knows about
  // but the slice was missing. relocalize-pending-jobs.mjs does this for the
  // jobs it processes ("Sync previousSlugs from assembled dataset to
  // per-crawler file"); scatter is the writer for every OTHER job, so it must
  // mirror the carry-forward or those bridges are dropped from the committed
  // slice → 404s for URLs Google already indexed (issue class
  // #4165/#4161/#4134/#4112/#4102/#4088/#4076/#3885). Routed through the
  // journal-backed helper so every capture is recorded via recordSlugMutation,
  // exactly like trackSlugHistoryDrift's carry-forward. The add-list is already
  // bounded to the flat cap headroom so this can never evict a bridge the
  // slice already had.
  //
  // Recomputed HERE on `updatedJob` — AFTER the rename loop above — rather
  // than reusing `hasMissingBridgesPreRename`'s pre-rename list (issue #4208).
  // The rename loop just pushed this job's OLD per-locale slugs into
  // previousSlugsByLocale (and the flat previousSlugs mirror it keeps in
  // sync via addPreviousSlugForLocale → syncLegacyPreviousSlugs). Computing
  // headroom before that landed doesn't know those flat-cap slots are about
  // to be spent when 2+ locales rename in the same run, so it could hand
  // this loop more "missing" bridges than the cap truly has room for after
  // the rename — recomputing on the POST-rename state keeps headroom
  // accurate to what's actually left.
  const missingBridges = collectMissingAssembledBridges(updatedJob, assembled, { skipBridges });
  for (const { locale, slug } of missingBridges) {
    if (locale) {
      addPreviousSlugForLocale(updatedJob, locale, slug, DEFAULT_PREV_SLUG_CAP, `scatter-jobs-to-slices/carry-forward-${locale === 'it' ? 'flat' : 'locale'}`);
    } else {
      promotePreviousSlugToLegacy(updatedJob, slug, LEGACY_PREV_SLUGS_CAP, 'scatter-jobs-to-slices/carry-forward-legacy');
    }
  }

  return { job: updatedJob, changed: true };
}

/**
 * Project an assembled snapshot onto all active slices in memory, then run the
 * same ownership pass that the on-disk writer uses. Keeping both operations in
 * one projection prevents a bridge from being added to a claimant and moved
 * only after the claimant file has already been written. The owner-aware skip
 * also makes the second projection a true no-op after the first one moved the
 * bridge to its legitimate slice-only owner.
 *
 * @param {Array<object>} assembledJobs
 * @param {Array<{file?: string, filePath?: string, slice: {jobs: object[]}}>} sliceEntries
 * @returns {{entries: Array<object>, updatedJobs: number, updatedSlices: number, changedEntries: Array<object>, ownership: object}}
 */
export function scatterAssembledIntoSliceEntries(assembledJobs, sliceEntries, { persist = false, writeSlice = writeJson } = {}) {
  const entries = Array.isArray(sliceEntries) ? sliceEntries : [];
  const index = buildAssembledJobIndex(assembledJobs);
  const ownershipBefore = buildSliceOwnershipIndex(entries);
  const scatterChangedEntries = new Set();
  let updatedJobs = 0;

  for (const entry of entries) {
    if (!entry?.slice || !Array.isArray(entry.slice.jobs)) continue;
    let sliceChanged = false;
    const updatedSliceJobs = entry.slice.jobs.map((sliceJob) => {
      const assembled = matchAssembledJob(sliceJob, index);
      if (!assembled) return sliceJob;

      const skipBridges = bridgesOwnedByAnotherSlice(sliceJob, entry, assembled, ownershipBefore);
      const { job, changed } = applyAssembledToSliceJob(sliceJob, assembled, { skipBridges });
      if (changed) {
        sliceChanged = true;
        updatedJobs++;
      }
      return job;
    });
    if (sliceChanged) {
      entry.slice = { ...entry.slice, jobs: updatedSliceJobs };
      scatterChangedEntries.add(entry);
    }
  }

  // The assembled bridge may have been carried by a job whose current slice
  // is not its final owner. Normalize the complete prospective fleet before
  // persisting anything, so the final state is what parity verifies.
  //
  // With `persist`, the projected slices are written here, in the only order
  // that is safe for the slug-preservation guard of `writeJsonAtomic`: first
  // the scatter result under the normal guard, then the ownership pass with
  // the decontaminator's own writer (owners first, claimants last with the
  // guard off). Writing a claimant through the guarded writer would re-capture
  // the bridge it just handed over, because the on-disk version still serves
  // it, and the next run would move it again.
  if (persist) {
    for (const entry of [...scatterChangedEntries].sort((a, b) => String(a.filePath).localeCompare(String(b.filePath)))) {
      // Preserve the original assembledAt timestamp from the crawler. Scatter
      // only propagates locale/SEO changes from the assembled dataset.
      writeSlice(entry.filePath, entry.slice);
    }
  }
  const ownership = decontaminateEntries(entries, { apply: persist, writeSlice });
  const ownershipChangedPaths = new Set(ownership.affected.map((entry) => entry.filePath));
  const changedEntries = entries.filter((entry) => (
    scatterChangedEntries.has(entry) || ownershipChangedPaths.has(entry.filePath)
  ));

  return {
    entries,
    updatedJobs,
    updatedSlices: changedEntries.length,
    changedEntries,
    ownership,
  };
}

function main() {
  const jobs = readJson(DATA_JOBS, null);
  if (!Array.isArray(jobs)) {
    console.log('ℹ️  data/jobs.json not found or not an array — nothing to scatter.');
    process.exit(0);
  }

  // The assembled snapshot can still carry a previous-slug claim that the
  // slice ownership pass would redirect to another current job. Normalize the
  // in-memory source before scattering; otherwise the post-write ownership
  // pass would move the claim away and the next scatter run would add it back,
  // making the writer non-idempotent.
  const assembledOwnership = decontaminateJobs(jobs);
  if (assembledOwnership.moved > 0 || assembledOwnership.emptyLocaleBucketsPruned > 0) {
    console.log(`🧭 assembled prev-slug ownership: redirected ${assembledOwnership.moved} slug(s), pruned ${assembledOwnership.emptyLocaleBucketsPruned} empty locale bucket(s) in memory.`);
  }

  // Read every slice once and project the assembled data and the ownership
  // normalization on the same in-memory fleet, so the ownership pass sees the
  // bridges this run carried forward.
  const sliceEntries = fs.existsSync(SLICES_DIR)
    ? readSliceFileEntries(SLICES_DIR)
    : [];
  const projection = scatterAssembledIntoSliceEntries(jobs, sliceEntries, { persist: true });

  if (projection.updatedJobs > 0) {
    console.log(`✅ Scattered ${projection.updatedJobs} updated jobs across ${projection.updatedSlices} per-crawler slices.`);
  } else {
    console.log('ℹ️  No changes to scatter back to per-crawler slices.');
  }

  const ownership = projection.ownership;
  if (ownership.moved > 0 || ownership.emptyLocaleBucketsPruned > 0) {
    console.log(`🧭 prev-slug ownership: redirected ${ownership.moved} slug(s), pruned ${ownership.emptyLocaleBucketsPruned} empty locale bucket(s) across ${ownership.affected.length} slice(s).`);
  }

  // Verify what was actually persisted, not the in-memory projection: the
  // writer applies the slug-preservation guard, so only a re-read proves the
  // committed slices match the assembled snapshot.
  const parity = verifyScatterParity(jobs, readSliceFileEntries(SLICES_DIR).map(({ file, slice }) => ({ file, jobs: slice.jobs })));
  console.log(`🔎 SCATTER_PARITY ${JSON.stringify(parity)}`);
  if (!parity.passed) {
    console.error('❌ Scatter parity failed — refusing to publish an unverified assembled→slice projection.');
    process.exitCode = 1;
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main();
}

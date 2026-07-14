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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic as writeJson } from './lib/atomic-write-json.mjs';
import { addPreviousSlugForLocale, DEFAULT_PREV_SLUG_CAP, LEGACY_PREV_SLUGS_CAP, LOCALES } from './lib/dedicated-crawler-common.mjs';
import { resolveJobDiffKey } from './lib/job-match-key.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.join(ROOT, 'data', 'jobs.json');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');

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
 * assemble-jobs-dataset's trackSlugHistoryDrift / ensureLocaleFields / the
 * cross-job collision guard) but that the per-crawler slice — the committed
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
 * @returns {Array<{ locale: string|null, slug: string }>} ordered add-list
 */
export function collectMissingAssembledBridges(sliceJob, assembled) {
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
        if (!v || bucket.includes(v)) continue;
        const dedupKey = `${locale} ${v}`;
        if (seen.has(dedupKey)) continue;
        const consumesHeadroom = !known.has(v);
        if (consumesHeadroom && adds.filter((a) => !a._free).length >= headroom) continue;
        seen.add(dedupKey);
        adds.push({ locale, slug: v, _free: !consumesHeadroom });
        if (consumesHeadroom) known.add(v);
      }
    }
  }
  // Pass 2: unattributed flat-only bridges → default to the IT bucket, only up
  // to remaining headroom.
  for (const s of (Array.isArray(assembled.previousSlugs) ? assembled.previousSlugs : [])) {
    const v = String(s || '');
    if (!v || known.has(v)) continue;
    if (adds.filter((a) => !a._free).length >= headroom) break;
    known.add(v);
    adds.push({ locale: 'it', slug: v, _free: false });
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
 * @returns {{ job: object, changed: boolean }}
 */
export function applyAssembledToSliceJob(sliceJob, assembled) {
  // SEO bridge slugs the assembled job captured (trackSlugHistoryDrift /
  // ensureLocaleFields / collision guard) but the slice is still missing.
  // Computed up front so it can ALSO trigger a write for a job whose
  // locale/slug fields are otherwise unchanged — otherwise a slug renamed on
  // the assembled side in a prior run (its old value living only in the
  // assembled previousSlugs) would never make it onto the committed slice.
  const missingBridges = collectMissingAssembledBridges(sliceJob, assembled);

  // Compare locale fields — only update if they changed
  const changed =
    JSON.stringify(assembled.titleByLocale) !== JSON.stringify(sliceJob.titleByLocale) ||
    JSON.stringify(assembled.descriptionByLocale) !== JSON.stringify(sliceJob.descriptionByLocale) ||
    JSON.stringify(assembled.slugByLocale) !== JSON.stringify(sliceJob.slugByLocale) ||
    missingBridges.length > 0;

  if (!changed) return { job: sliceJob, changed: false };

  // Defensive merge: never overwrite a non-empty locale value with an empty one.
  // The assembled data may have had locales stripped by ensureLocaleFields when
  // AI translation failed — the per-crawler file is the source of truth.
  const mergedTitle = mergeLocaleMap(sliceJob.titleByLocale, assembled.titleByLocale);
  const mergedDesc = mergeLocaleMap(sliceJob.descriptionByLocale, assembled.descriptionByLocale);
  const mergedSlug = mergeLocaleMap(sliceJob.slugByLocale, assembled.slugByLocale);

  // Track slug changes: preserve old slug values in previousSlugsByLocale so the build
  // plugin can generate bridge/redirect pages for SEO continuity (prevents 404s
  // for URLs that Google/Bing may have already indexed).
  const oldSlugs = sliceJob.slugByLocale && typeof sliceJob.slugByLocale === 'object'
    ? sliceJob.slugByLocale : {};
  const newSlugs = mergedSlug && typeof mergedSlug === 'object' ? mergedSlug : {};

  const updatedJob = { ...sliceJob, titleByLocale: mergedTitle, descriptionByLocale: mergedDesc, slugByLocale: mergedSlug };

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
  for (const { locale, slug } of missingBridges) {
    addPreviousSlugForLocale(updatedJob, locale, slug, DEFAULT_PREV_SLUG_CAP, `scatter-jobs-to-slices/carry-forward-${locale === 'it' ? 'flat' : 'locale'}`);
  }

  return { job: updatedJob, changed: true };
}

function main() {
  const jobs = readJson(DATA_JOBS, null);
  if (!Array.isArray(jobs)) {
    console.log('ℹ️  data/jobs.json not found or not an array — nothing to scatter.');
    process.exit(0);
  }

  // Index assembled jobs by stable diff key (id / url / slug fallback — see
  // resolveJobDiffKey) — NOT bare .slug. Bare-slug keying collides across
  // companies whenever two jobs compute the same slug (463 live collisions
  // confirmed in data/jobs/by-crawler/*.json, e.g. klinik-sonnenhalde vs.
  // allianz-suisse), silently merging wrong-company locale/slug data into a
  // slice (previousSlugs writer regression, issue #3734).
  const jobIndex = new Map();
  for (const job of jobs) {
    const key = resolveJobDiffKey(job);
    if (key) jobIndex.set(key, job);
  }

  // Read each slice, update jobs with matching slugs, write back if changed
  const sliceFiles = fs.existsSync(SLICES_DIR)
    ? fs.readdirSync(SLICES_DIR).filter((f) => f.endsWith('.json') && f !== '.gitkeep')
    : [];

  let updatedSlices = 0;
  let updatedJobs = 0;

  for (const file of sliceFiles) {
    const slicePath = path.join(SLICES_DIR, file);
    const slice = readJson(slicePath, null);
    if (!slice || !Array.isArray(slice.jobs)) continue;

    let sliceChanged = false;
    const updatedSliceJobs = slice.jobs.map((sliceJob) => {
      const sliceKey = resolveJobDiffKey(sliceJob);
      if (!sliceKey) return sliceJob;
      const assembled = jobIndex.get(sliceKey);
      if (!assembled) return sliceJob;

      const { job, changed } = applyAssembledToSliceJob(sliceJob, assembled);
      if (changed) {
        sliceChanged = true;
        updatedJobs++;
      }
      return job;
    });

    if (sliceChanged) {
      // Preserve the original assembledAt timestamp from the crawler.
      // Scatter only propagates locale changes from the assembled dataset — it
      // does not represent a new crawl run, so bumping assembledAt would cause
      // unnecessary git churn across 90+ files when only a single company was
      // actually translated.
      const envelope = { ...slice, jobs: updatedSliceJobs };
      writeJson(slicePath, envelope);
      updatedSlices++;
    }
  }

  if (updatedSlices > 0) {
    console.log(`✅ Scattered ${updatedJobs} updated jobs across ${updatedSlices} per-crawler slices.`);
  } else {
    console.log('ℹ️  No changes to scatter back to per-crawler slices.');
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}

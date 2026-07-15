// scripts/migrate-all-known-job-slugs-canton-aware.mjs
// Phase 8 Sub-PR (c): one-shot migration that rewrites every per-locale path in
// data/all-known-job-slugs.json so that non-TI jobs use their canton-aware
// section slug (e.g. /cerca-lavoro-zurigo/...) instead of the legacy TI section.
//
// Before this migration, every tracking entry was emitted under the frozen TI
// section path because the builder at jobsSeoPagesPlugin.ts (~line 8057) used
// `sectionByLocale[locale]` unconditionally. With cathedral now emitting the
// active per-job pages at canton-aware URLs, expired soft-landings written
// from the TI-section tracking path are stale (best case) or clobber an
// active non-TI page that happens to slug-collide (worst case).
//
// Strategy:
//   1. Build a slug -> canton index from data/jobs.json. Index by job.slug,
//      every slugByLocale.* value, and every previousSlugs[*] entry.
//   2. For every tracking entry, look up the master slug in that index.
//        Found  -> rewrite each per-locale path's section slug using the
//                  canton-aware resolver imported from the shared single source
//                  of truth (build-plugins/shared/cantonResolvers.mjs — the same
//                  module the build-time page-emit binds via cantonSection.ts),
//                  so registry and page-emit can never resolve a different
//                  canton section.
//        Missing-> keep the TI path (orphan slug; preserves prior behaviour).
//   3. Preserve any non-locale metadata on the entry (e.g. `source`,
//      `importedAt` from the GSC-404 import path).
//   4. Re-emit the file with 2-space indent + trailing newline.
//
// TI invariance: jobs whose resolved canton is TI keep the legacy section
// path verbatim — resolveCantonSection short-circuits on 'TI'.
import fs from 'node:fs';
import path from 'node:path';
import { createCantonResolvers, AGGREGATE_KEY } from '../build-plugins/shared/cantonResolvers.mjs';

const TRACKING_PATH = path.resolve('data/all-known-job-slugs.json');
const JOBS_PATH = path.resolve('data/jobs.json');
const CANTON_SLUGS_PATH = path.resolve('data/canton-url-slugs.json');
const MUNI_PATH = path.resolve('data/canton-municipalities.json');

const LOCALES = ['it', 'en', 'de', 'fr'];
const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' };

// ── Bind the shared canton resolvers to the on-disk reference data ──
// Logic is single-sourced in cantonResolvers.mjs; here we only supply the
// JSON the raw-node runtime reads with `fs` (Vite consumers import it instead).
const cantonSlugFile = JSON.parse(fs.readFileSync(CANTON_SLUGS_PATH, 'utf8'));
const municipalitiesFile = JSON.parse(fs.readFileSync(MUNI_PATH, 'utf8'));
const { resolveCantonSection, resolveJobCanton, ALL_CANTON_CODES } = createCantonResolvers({
  cantonSlugFile,
  municipalitiesFile,
});

// Whitelist of every URL section the page-emit can legitimately produce, per
// locale. This is the exact set of `resolveCantonSection` outputs over every
// canton code (+ TI legacy + aggregate) — i.e. precisely the sections a real
// job page is ever emitted under. We enumerate the resolver rather than
// prefix-matching `SECTION_PREFIX_BY_LOCALE`, because a naive prefix check would
// miss the `de` legacy section (`jobs-im-tessin`, prefix `jobs-im` ≠ `jobs-in`)
// and any `dePrefix` canton, silently treating them as non-sections.
const VALID_SECTIONS_BY_LOCALE = {};
for (const locale of LOCALES) {
  const sections = new Set();
  for (const code of [...ALL_CANTON_CODES, 'TI', AGGREGATE_KEY]) {
    sections.add(resolveCantonSection(locale, code));
  }
  VALID_SECTIONS_BY_LOCALE[locale] = sections;
}

// ── Migration body ─────────────────────────────────────────────────
const tracking = JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf8'));
const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));

// 1. Index every job slug-alias -> job (so we can resolve its canton).
const slugToJob = new Map();
for (const job of jobs) {
  const aliases = new Set();
  if (job?.slug) aliases.add(String(job.slug));
  if (job?.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const v of Object.values(job.slugByLocale)) {
      if (v) aliases.add(String(v));
    }
  }
  if (Array.isArray(job?.previousSlugs)) {
    for (const v of job.previousSlugs) {
      if (v) aliases.add(String(v));
    }
  }
  for (const alias of aliases) {
    if (!slugToJob.has(alias)) slugToJob.set(alias, job);
  }
}

let rewritten = 0;
let kept = 0;
let orphanKept = 0;
let nonSectionSkipped = 0;
const cantonStats = new Map();

const out = {};
for (const [trackingSlug, entry] of Object.entries(tracking)) {
  if (!entry || typeof entry !== 'object') {
    out[trackingSlug] = entry;
    continue;
  }
  const job = slugToJob.get(trackingSlug);
  if (!job) {
    orphanKept++;
    out[trackingSlug] = entry;
    continue;
  }
  const canton = resolveJobCanton({ canton: job.canton, location: job.location });
  cantonStats.set(canton, (cantonStats.get(canton) || 0) + 1);
  // Reconcile EVERY locale path to the job's CURRENT canton section — not only
  // TI→canton. The old `if (!oldPath.startsWith(tiPrefix)) continue` skipped any
  // path already on a non-TI section, so a job that later migrated BETWEEN non-TI
  // cantons (e.g. ZH→BE) kept its first non-TI section forever → the canon map /
  // 404 bridge then 301'd the orphan to a canton where the live page no longer
  // exists (a redirect to a dead page, never recovered). Replacing only the
  // SECTION segment and keeping the rest (slug + trailing slash) verbatim keeps
  // the slug-body invariant (tests/migrate-all-known-job-slugs-canton-aware.test.ts)
  // and makes a TI job a natural no-op (resolveCantonSection('TI') returns the
  // legacy TI section), so TI invariance still holds without a special-case.
  const newEntry = { ...entry };
  let touched = false;
  for (const locale of LOCALES) {
    const oldPath = entry[locale];
    if (typeof oldPath !== 'string' || !oldPath.startsWith('/')) continue;
    const lp = LOCALE_PREFIX[locale]; // '', '/en', '/de', '/fr'
    let afterLp;
    if (lp) {
      if (!oldPath.startsWith(`${lp}/`)) continue; // locale-prefix mismatch — leave it
      afterLp = oldPath.slice(lp.length);
    } else {
      afterLp = oldPath;
    }
    const m = afterLp.match(/^\/([^/]+)\/(.*)$/); // [, section, rest]
    if (!m) continue; // not a /<section>/<slug> path — leave it
    // Guard the first-segment rewrite: only reconcile a path whose CURRENT
    // section is one the resolver itself emits. A hand-edited or non-section
    // entry (e.g. /chi-siamo/..., /blog/...) would otherwise have its first
    // segment silently clobbered toward a canton section, 301'ing to a page
    // that was never emitted. The current ledger is 100% section-shaped (this
    // is a future-proofing guard, not a fix for live data).
    if (!VALID_SECTIONS_BY_LOCALE[locale].has(m[1])) {
      console.warn(`  [guard] skip non-section path (${locale}, ${trackingSlug}): ${oldPath}`);
      nonSectionSkipped++;
      continue;
    }
    const rest = m[2]; // slug body + any trailing slash, preserved verbatim
    const newSection = resolveCantonSection(locale, canton);
    const newPath = `${lp}/${newSection}/${rest}`;
    if (newPath !== oldPath) {
      newEntry[locale] = newPath;
      touched = true;
    }
  }
  if (touched) rewritten++;
  else kept++;
  out[trackingSlug] = newEntry;
}

fs.writeFileSync(TRACKING_PATH, JSON.stringify(out) + '\n');

console.log('all-known-job-slugs canton-aware migration:');
console.log(`  total tracking entries:      ${Object.keys(tracking).length}`);
console.log(`  rewritten (non-TI job):      ${rewritten}`);
console.log(`  kept (TI job — invariance):  ${kept}`);
console.log(`  kept (orphan, no live job):  ${orphanKept}`);
console.log(`  skipped (non-section path):  ${nonSectionSkipped}`);
console.log('  canton distribution of matched jobs:');
const cantonSorted = [...cantonStats.entries()].sort((a, b) => b[1] - a[1]);
for (const [c, n] of cantonSorted) console.log(`    ${c.padEnd(6)} ${n}`);

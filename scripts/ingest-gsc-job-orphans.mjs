#!/usr/bin/env node
/**
 * ingest-gsc-job-orphans.mjs
 *
 * Ingests GSC Coverage Drilldown CSV exports and classifies each job-detail
 * 404 URL as either:
 *   - "matched"  → current jobs.json has a slug that is a longer prefix of
 *                  the orphan slug OR shares the first 30 chars with the
 *                  orphan. The orphan can bridge to the current canonical.
 *   - "expired"  → no current job matches. Render a soft-landing with
 *                  related-by-company content.
 *
 * Output: `data/gsc-job-orphans.json`, consumed by
 * `build-plugins/jobOrphanBridgePlugin.ts` to emit 200 HTML bridge pages
 * for every entry (closing the GSC "Indicizzata Non trovata" cohort
 * without 301-redirecting — preserves AdSense rendering).
 *
 * Mirrors the pattern of `ingest-gsc-orphans-into-candidates.mjs` for the
 * related-search cluster cohort (PR #81).
 *
 * Usage:
 *   node scripts/ingest-gsc-job-orphans.mjs              # write
 *   node scripts/ingest-gsc-job-orphans.mjs --dry-run    # report only
 *
 * Reads every `Tabella.csv` under `download/frontaliereticino.ch-Coverage-*`
 * + `data/jobs.json` + `data/expired-jobs.json` (optional, may be missing).
 * Additive and idempotent: GSC exports are limited samples, so URLs absent
 * from a later export are retained rather than treated as resolved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTION_LEGACY_TI } from '../build-plugins/shared/cantonResolvers.mjs';
import { withSingleFlightLock } from './lib/single-flight-lock.mjs';
import { urlToOrphan } from './lib/gsc-job-orphans.mjs';
import {
  assertGscOrphanSnapshot,
  gscOrphanRouteKey,
  mergeGscOrphanRecords,
} from './lib/gsc-orphan-snapshot.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const EXPIRED_PATH = path.join(ROOT, 'data', 'expired-jobs.json');
const CANTON_SLUGS_PATH = path.join(ROOT, 'data', 'canton-url-slugs.json');
const DOWNLOADS_DIR = path.join(ROOT, 'download');
const OUT_PATH = path.join(ROOT, 'data', 'gsc-job-orphans.json');

const DRY_RUN = process.argv.includes('--dry-run');

const LOCALES = ['it', 'en', 'de', 'fr'];

const SECTION_PREFIX = {
  it: 'cerca-lavoro',
  en: 'find-jobs',
  de: 'jobs-in',
  fr: 'trouver-emploi',
};

function loadJobSectionSlugs() {
  const raw = JSON.parse(fs.readFileSync(CANTON_SLUGS_PATH, 'utf-8'));
  const out = Object.fromEntries(LOCALES.map((locale) => [locale, new Set([SECTION_LEGACY_TI[locale]])]));
  for (const locale of LOCALES) {
    const aggregateSlug = raw.aggregate?.[locale];
    if (aggregateSlug) out[locale].add(`${SECTION_PREFIX[locale]}-${aggregateSlug}`);
  }
  for (const entry of Object.values(raw.cantons || {})) {
    for (const locale of LOCALES) {
      if (locale === 'de' && entry.dePrefix && entry.de) {
        out.de.add(`${entry.dePrefix}${entry.de}`);
      } else if (entry[locale]) {
        out[locale].add(`${SECTION_PREFIX[locale]}-${entry[locale]}`);
      }
    }
  }
  return out;
}

const JOB_SECTION_SLUGS = loadJobSectionSlugs();

function findCsvFiles() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(DOWNLOADS_DIR).sort()) {
    if (!entry.startsWith('frontaliereticino.ch-Coverage-')) continue;
    const csv = path.join(DOWNLOADS_DIR, entry, 'Tabella.csv');
    if (fs.existsSync(csv)) out.push({ file: csv, basename: entry });
  }
  return out;
}

function parseCsvUrls(file) {
  const text = fs.readFileSync(file, 'utf-8');
  return text.split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[0]).filter(Boolean);
}

/**
 * Build a slug index keyed by `${locale}::${slug}` → { jobId, currentSlug:[per locale] }.
 * Includes current slugs, slugByLocale entries, previousSlugs (flat + per-locale).
 */
function buildSlugIndex(jobs) {
  const idx = new Map();
  const slugsByJob = new Map(); // jobId → per-locale current slug map for canonical URL
  for (const job of jobs) {
    const perLocale = {};
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const s = job.slugByLocale?.[loc] || job.slug || '';
      if (s) perLocale[loc] = s;
    }
    slugsByJob.set(job.id, perLocale);

    for (const [loc, s] of Object.entries(job.slugByLocale || {})) {
      if (s) idx.set(`${loc}::${s}`, { jobId: job.id, locale: loc, kind: 'current' });
    }
    if (job.slug) idx.set(`it::${job.slug}`, { jobId: job.id, locale: 'it', kind: 'current-flat' });
    for (const ps of (job.previousSlugs || [])) idx.set(`it::${ps}`, { jobId: job.id, locale: 'it', kind: 'previous' });
    if (job.previousSlugsByLocale) {
      for (const [loc, arr] of Object.entries(job.previousSlugsByLocale)) {
        for (const s of (arr || [])) if (s) idx.set(`${loc}::${s}`, { jobId: job.id, locale: loc, kind: 'previous' });
      }
    }
  }
  return { idx, slugsByJob };
}

/** Try prefix match: any current/previous slug whose first chars equal the orphan. */
function findPrefixMatch(orphan, jobs) {
  for (const job of jobs) {
    const slugs = [job.slug, ...Object.values(job.slugByLocale || {})].filter(Boolean);
    for (const s of slugs) {
      if (s.startsWith(orphan.slug) && s.length > orphan.slug.length) {
        const localizedSlug = job.slugByLocale?.[orphan.locale] || job.slug || '';
        if (localizedSlug) return { job, localizedSlug };
      }
    }
  }
  return null;
}

/** Try 30-char head match (reslug case): different slug, same job. */
function findReslugMatch(orphan, jobs) {
  const head = orphan.slug.slice(0, 30);
  if (head.length < 20) return null; // Too short, unreliable signal
  for (const job of jobs) {
    const slugs = [job.slug, ...Object.values(job.slugByLocale || {})].filter(Boolean);
    for (const s of slugs) {
      if (s.startsWith(head) && s !== orphan.slug) {
        const localizedSlug = job.slugByLocale?.[orphan.locale] || job.slug || '';
        if (localizedSlug) return { job, localizedSlug };
      }
    }
  }
  return null;
}

/**
 * Extract a company "hint" from the orphan slug — the trailing N-K tokens that
 * usually carry the company name + city. Used for soft-landing related-jobs
 * matching when no current job is found.
 *
 * Slug shape (audit-derived):
 *   <title-tokens>-<company-tokens>-<city>
 * Heuristic: take the last 3-5 tokens.
 */
function extractCompanyHint(slug) {
  const tokens = slug.split('-').filter(Boolean);
  if (tokens.length < 4) return null;
  return tokens.slice(-Math.min(4, Math.max(2, Math.floor(tokens.length / 2)))).join('-');
}

function classifyOrphan(orphan, jobs, slugIndex, jobsById, expiredIdx, csvBasename) {
  // Match against current jobs (any locale's current/previous slug)
  for (const loc of ['it', 'en', 'de', 'fr']) {
    const hit = slugIndex.idx.get(`${loc}::${orphan.slug}`);
    if (hit) {
      const localizedSlug = slugIndex.slugsByJob.get(hit.jobId)?.[orphan.locale];
      if (localizedSlug) {
        return {
          ...orphan,
          kind: 'matched',
          jobId: hit.jobId,
          currentSlug: localizedSlug,
          matchType: hit.kind,
          csvOrigin: csvBasename,
        };
      }
    }
  }

  // Keep a previous job-id association when a job's slug changed enough that
  // the old route no longer matches by exact, prefix, or reslug heuristics.
  const previouslyMatchedJob = orphan.kind === 'matched' && orphan.jobId
    ? jobsById.get(orphan.jobId)
    : null;
  const previousLocalizedSlug = previouslyMatchedJob?.slugByLocale?.[orphan.locale]
    || previouslyMatchedJob?.slug
    || '';
  if (previouslyMatchedJob && previousLocalizedSlug) {
    return {
      ...orphan,
      kind: 'matched',
      jobId: previouslyMatchedJob.id,
      currentSlug: previousLocalizedSlug,
      matchType: 'previous-job-id',
      csvOrigin: csvBasename,
    };
  }

  // Prefix match (90-char truncation case)
  const prefix = findPrefixMatch(orphan, jobs);
  if (prefix) {
    return {
      ...orphan,
      kind: 'matched',
      jobId: prefix.job.id,
      currentSlug: prefix.localizedSlug,
      matchType: 'prefix',
      csvOrigin: csvBasename,
    };
  }

  // Reslug match (translation/hash drift)
  const reslug = findReslugMatch(orphan, jobs);
  if (reslug) {
    return {
      ...orphan,
      kind: 'matched',
      jobId: reslug.job.id,
      currentSlug: reslug.localizedSlug,
      matchType: 'reslug',
      csvOrigin: csvBasename,
    };
  }

  // Check expired-jobs.json
  const expiredHit = expiredIdx.get(`${orphan.locale}::${orphan.slug}`);
  if (expiredHit) {
    return {
      ...orphan,
      kind: 'expired-tracked',
      expiredJobId: expiredHit.id,
      company: expiredHit.company || extractCompanyHint(orphan.slug),
      csvOrigin: csvBasename,
    };
  }

  // Truly expired — no record anywhere
  return {
    ...orphan,
    kind: 'expired',
    company: extractCompanyHint(orphan.slug),
    csvOrigin: csvBasename,
  };
}

function buildExpiredIndex(expiredArr) {
  const idx = new Map();
  for (const ej of expiredArr) {
    for (const [loc, s] of Object.entries(ej.slugByLocale || {})) if (s) idx.set(`${loc}::${s}`, ej);
    if (ej.slug) idx.set(`it::${ej.slug}`, ej);
    for (const ps of (ej.previousSlugs || [])) idx.set(`it::${ps}`, ej);
    if (ej.previousSlugsByLocale) {
      for (const [loc, arr] of Object.entries(ej.previousSlugsByLocale)) {
        for (const s of (arr || [])) if (s) idx.set(`${loc}::${s}`, ej);
      }
    }
  }
  return idx;
}

function main() {
  if (!fs.existsSync(JOBS_PATH)) {
    console.error(`✗ ${JOBS_PATH} not found.`);
    process.exitCode = 1;
    return;
  }

  const csvFiles = findCsvFiles();
  if (csvFiles.length === 0) {
    console.error('No GSC CSV exports found under download/frontaliereticino.ch-Coverage-*');
    process.exitCode = 1;
    return;
  }

  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  const expiredArr = fs.existsSync(EXPIRED_PATH)
    ? (() => { const e = JSON.parse(fs.readFileSync(EXPIRED_PATH, 'utf-8')); return Array.isArray(e) ? e : (e.jobs || e.entries || []); })()
    : [];
  const expiredIdx = buildExpiredIndex(expiredArr);
  const slugIndex = buildSlugIndex(jobs);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));

  console.log(`Loaded ${jobs.length} jobs, ${expiredArr.length} expired-job records.`);

  const importedByUrl = new Map();

  for (const { file, basename } of csvFiles) {
    const urls = parseCsvUrls(file);
    for (const url of urls) {
      const o = urlToOrphan(url, JOB_SECTION_SLUGS);
      if (!o) continue;
      const classified = classifyOrphan(o, jobs, slugIndex, jobsById, expiredIdx, basename);
      importedByUrl.set(gscOrphanRouteKey(classified), classified);
    }
  }

  let existingFile = { sources: [], orphans: [] };
  if (fs.existsSync(OUT_PATH)) {
    existingFile = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
    assertGscOrphanSnapshot(existingFile, {
      file: path.relative(ROOT, OUT_PATH),
      recordsKey: 'orphans',
      identityField: 'slug',
      kinds: ['matched', 'expired-tracked', 'expired'],
      validateRoute: (entry) => {
        const parsed = urlToOrphan(entry.url, JOB_SECTION_SLUGS);
        return parsed?.locale === entry.locale && parsed?.slug === entry.slug;
      },
      validateRecord: (entry) => entry.kind === 'matched'
        ? typeof entry.jobId === 'string' && entry.jobId.length > 0
        : entry.jobId === undefined,
    });
  }
  const imported = [...importedByUrl.values()];
  // GSC's export is a capped sample: disappearance from a later sample is not
  // evidence that the source URL resolved, so prior routes are retained.
  const refreshedExisting = existingFile.orphans.map((old) => classifyOrphan(
    { locale: old.locale, slug: old.slug, url: old.url, kind: old.kind, jobId: old.jobId },
    jobs,
    slugIndex,
    jobsById,
    expiredIdx,
    old.csvOrigin,
  ));
  const orphans = mergeGscOrphanRecords(refreshedExisting, imported);
  const retained = Math.max(0, orphans.length - imported.length);

  // Summary
  const counts = orphans.reduce((acc, o) => { acc[o.kind] = (acc[o.kind] || 0) + 1; return acc; }, {});
  console.log(`\nImported job-orphans: ${imported.length}`);
  console.log(`Retained from prior imports (not present in this sample): ${retained}`);
  console.log(`Total tracked job-orphans: ${orphans.length}`);
  console.log('By kind:');
  for (const [k, n] of Object.entries(counts)) console.log(`  ${k}: ${n}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing. First 5 of each kind:');
    for (const kind of ['matched', 'expired-tracked', 'expired']) {
      const sample = orphans.filter((o) => o.kind === kind).slice(0, 5);
      if (sample.length) console.log(`\n${kind}:`);
      for (const s of sample) console.log(`  [${s.locale}] ${s.slug.slice(0, 70)}${s.slug.length > 70 ? '…' : ''}${s.currentSlug ? ` → ${s.currentSlug.slice(0, 50)}` : ''}`);
    }
    return;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sources: [...new Set([...(existingFile.sources || []), ...csvFiles.map((c) => c.basename)])],
    counts,
    orphans,
  };
  const tempPath = `${OUT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  fs.renameSync(tempPath, OUT_PATH);
  console.log(`\nWrote ${orphans.length} job-orphan records to ${path.relative(ROOT, OUT_PATH)}`);
}

const lock = withSingleFlightLock(`${OUT_PATH}.lock`, main);
if (!lock.acquired) {
  console.error(`✗ ${path.relative(ROOT, OUT_PATH)} is already being updated; retry after it completes.`);
  process.exitCode = 1;
}

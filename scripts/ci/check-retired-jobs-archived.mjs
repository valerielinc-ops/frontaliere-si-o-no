#!/usr/bin/env node
/**
 * Observer: a posting that leaves the active job set must stay reachable as an
 * expired soft-landing, i.e. land in the expired archive WITH its title.
 *
 * Without an archive record carrying a title, the build serves the job URL as
 * the noindex «Offerta non verificata · rif. <hash>» stub
 * (build-plugins/shared/jobArchiveEvidence.ts) instead of the indexable
 * soft-landing with title, data and similar jobs. Measured live on 2026-11-12:
 * 26 of the 600 top job pages (5,5% of their clicks) were such stubs, all
 * postings that had been active a week earlier. Città di Locarno, Guess and
 * Sintetica had dropped them through bespoke runners that never archived an
 * ordinary removal (scripts/assemble-jobs-dataset.mjs writeJobsCrawlerSlice).
 *
 * The check compares two revisions of the data (`--base`, `--head`):
 *
 *   retired-unarchived  rows active at base whose slug, at head, is neither
 *                       served by an active row (slug, locale slug or slug
 *                       history) nor by an expired entry with a title;
 *   archive-lost        expired entries with a title at base whose slug, at
 *                       head, has the same lack of coverage — an archive that
 *                       shrinks between two builds (a writer that rewrites the
 *                       expired slice from a partial read, a merge that drops
 *                       records) falls here.
 *   active-locale-slug-lost
 *                       explicit locale routes on active base rows that have
 *                       no equal active, historical-alias, or titled-expired
 *                       path at head.
 *
 * All three are printed on every run, with totals per crawler. The two
 * existing thresholds retain their original behavior; the locale-slug
 * threshold also defaults to 0 so one lost active route fails closed.
 *
 * Usage:
 *   node scripts/ci/check-retired-jobs-archived.mjs --base <rev> [--head <rev>]
 *     [--max-retired-unarchived N] [--max-archive-lost N]
 *     [--max-active-locale-slug-lost N] [--json <path>] [--prefetch]
 *
 * `--prefetch` backfills the slice blobs of both revisions that a blobless CI
 * checkout does not have yet through Git's promisor-aware backfill command in
 * scripts/ci/prefetch-history-blobs.mjs.
 */

import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { isHeldFromPublication } from '../lib/translation-publication-hold.mjs';
import { isSliceFile } from '../lib/crawler-slice-files.mjs';
import { expiredSliceKeyOf } from '../lib/expired-slice-names.mjs';
import { DEFAULT_JSON_STRING_LIMIT, parseLargeJsonArray } from '../lib/read-large-json.mjs';
import { createCantonResolvers } from '../../build-plugins/shared/cantonResolvers.mjs';
import {
  backfillHistoryBlobs,
  verifyPrefetchedBlobs,
} from './prefetch-history-blobs.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');
const ACTIVE_DIR = 'data/jobs/by-crawler';
const EXPIRED_DIR = 'data/jobs/expired/by-crawler';
const JOB_LOCALES = ['it', 'en', 'de', 'fr'];
const cantonResolvers = createCantonResolvers({
  cantonSlugFile: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canton-url-slugs.json'), 'utf8')),
  municipalitiesFile: JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canton-municipalities.json'), 'utf8')),
});

const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;

/** Same identity evidence the build reads (build-plugins/shared/jobArchiveEvidence.ts). */
export function hasArchivedTitle(entry) {
  return nonblank(entry?.title) || Object.values(entry?.titleByLocale || {}).some(nonblank);
}

/** Builds category-specific recovery guidance for the observer issue body. */
export function buildFailureIssueDescription(report = {}, runUrl = '') {
  const count = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  };
  const retiredUnarchived = count(report?.retiredUnarchived);
  const archiveLost = count(report?.archiveLost);
  const activeLocaleSlugLost = count(report?.activeLocaleSlugLost);
  const lines = ['## Retired-job archive observer findings'];

  if (retiredUnarchived > 0) {
    lines.push(`- ${retiredUnarchived} retired posting(s) left the active set without a titled expired archive record. Recovery: dispatch backfill-expired-from-history.yml with dry_run=false for the listed crawlers.`);
  }
  if (archiveLost > 0) {
    lines.push(`- ${archiveLost} titled expired archive record(s) disappeared between revisions. Recovery: dispatch backfill-expired-from-history.yml with dry_run=false for the listed crawlers.`);
  }
  if (activeLocaleSlugLost > 0) {
    lines.push(`- ${activeLocaleSlugLost} locale route(s) were lost while the offer remains active. Recovery: preserve or restore the affected locale slugs on the active posting; expired-archive backfill does not repair an offer that remains active.`);
  }
  if (retiredUnarchived === 0 && archiveLost === 0 && activeLocaleSlugLost === 0) {
    lines.push('The observer failed before it produced category counts. Inspect the run log to identify the cause.');
  }
  if (nonblank(runUrl)) lines.push('', `**Run:** ${runUrl.trim()}`);
  return lines.join('\n');
}

function addRoutes(target, job, { withHistory }) {
  const add = (value) => {
    if (nonblank(value)) target.add(value.trim());
  };
  add(job?.slug);
  if (job?.slugByLocale && typeof job.slugByLocale === 'object') {
    for (const value of Object.values(job.slugByLocale)) add(value);
  }
  if (!withHistory) return;
  if (Array.isArray(job?.previousSlugs)) job.previousSlugs.forEach(add);
  if (job?.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object') {
    for (const values of Object.values(job.previousSlugsByLocale)) {
      if (Array.isArray(values)) values.forEach(add);
    }
  }
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

/** Mirrors localizedActiveJobSlug() in build-plugins/shared/activeJobPageSelection.ts. */
function localizedActiveJobSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;

  const canonical = String(job?.slug || '').trim();
  if (canonical) return canonical;

  const localizedTitle = String(job?.titleByLocale?.[locale] || job?.title || '');
  return slugify(`${localizedTitle}-${job?.company || ''}-${job?.location || ''}`)
    || slugify(localizedTitle);
}

/** Exact canonical job path shape from build-plugins/shared/jobDetailPath.ts. */
function activeJobPath(job, locale, slug) {
  const canton = cantonResolvers.resolveJobCanton({ canton: job?.canton, location: job?.location });
  const section = cantonResolvers.resolveCantonSection(locale, canton);
  const normalizedSlug = String(slug ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  const segments = [locale === 'it' ? '' : locale, section, normalizedSlug].filter(Boolean);
  return `/${segments.join('/')}/`;
}

function addHistoryPathsByLocale(target, job) {
  const localeHistory = job?.previousSlugsByLocale && typeof job.previousSlugsByLocale === 'object'
    ? job.previousSlugsByLocale
    : {};
  const localeAwareSlugs = new Set();
  for (const values of Object.values(localeHistory)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) if (typeof value === 'string' && value) localeAwareSlugs.add(value);
  }
  // The renderer treats flat entries already claimed by any locale-aware
  // bucket as locale-specific; only the remaining legacy entries fan out.
  const legacyOnly = Array.isArray(job?.previousSlugs)
    ? job.previousSlugs.filter((value) => nonblank(value) && !localeAwareSlugs.has(value))
    : [];

  for (const locale of JOB_LOCALES) {
    const localeSpecific = Array.isArray(localeHistory[locale]) ? localeHistory[locale] : [];
    for (const value of [...localeSpecific, ...legacyOnly]) {
      if (nonblank(value)) target.add(activeJobPath(job, locale, value));
    }
  }
}

/** Adds only the archived route that each locale would actually serve. */
function addExpiredHistoryPaths(target, entry) {
  const canonical = nonblank(entry?.slug) ? entry.slug.trim() : '';
  for (const locale of JOB_LOCALES) {
    const localized = nonblank(entry?.slugByLocale?.[locale]) ? entry.slugByLocale[locale].trim() : '';
    const slug = localized || canonical;
    if (slug) target.add(activeJobPath(entry, locale, slug));
  }
  // Keep the same locale-specific and genuinely-flat legacy history rules as
  // active rows; a flat value already claimed by a locale bucket stays local.
  addHistoryPathsByLocale(target, entry);
}

function isHeld(job) {
  return typeof job?.heldFromPublication === 'boolean'
    ? job.heldFromPublication
    : isHeldFromPublication(job);
}

/**
 * Pure measurement. Each argument maps a crawler key to the rows of that slice
 * at one revision. Coverage at head is global: a posting handed from one
 * crawler key to another is still served.
 *
 * @param {{
 *   baseActive: Map<string, object[]>,
 *   baseExpired: Map<string, object[]>,
 *   headActive: Map<string, object[]>,
 *   headExpired: Map<string, object[]>,
 * }} input
 */
export function measureRetiredArchiveCoverage({ baseActive, baseExpired, headActive, headExpired }) {
  const served = new Set();
  for (const rows of headActive.values()) {
    for (const job of rows) addRoutes(served, job, { withHistory: true });
  }
  for (const rows of headExpired.values()) {
    for (const entry of rows) {
      if (hasArchivedTitle(entry)) addRoutes(served, entry, { withHistory: true });
    }
  }

  const headActiveSlugs = new Set();
  for (const rows of headActive.values()) {
    for (const job of rows) addRoutes(headActiveSlugs, job, { withHistory: false });
  }

  const retiredUnarchived = [];
  let retired = 0;
  for (const [crawlerKey, rows] of baseActive) {
    for (const job of rows) {
      if (!nonblank(job?.slug)) continue;
      if (typeof job.heldFromPublication === 'boolean' ? job.heldFromPublication : isHeldFromPublication(job)) continue;
      if (headActiveSlugs.has(job.slug.trim())) continue;
      retired++;
      if (served.has(job.slug.trim())) continue;
      retiredUnarchived.push({ crawlerKey, slug: job.slug, title: job.title || '', canton: job.canton || '' });
    }
  }

  // Locale-slug coverage is keyed by the actual canonical URL path. Canton is
  // part of that path, so an equal slug in another canton is not evidence that
  // this route is still served. IDs are diagnostic only; ownership is decided
  // by route equality, including routes owned by a different row.
  const headActiveAndHistoryPaths = new Set();
  for (const rows of headActive.values()) {
    for (const job of rows) {
      if (isHeld(job)) continue;
      for (const locale of JOB_LOCALES) {
        const slug = localizedActiveJobSlug(job, locale);
        if (nonblank(slug)) headActiveAndHistoryPaths.add(activeJobPath(job, locale, slug));
      }
      addHistoryPathsByLocale(headActiveAndHistoryPaths, job);
    }
  }
  for (const rows of headExpired.values()) {
    for (const entry of rows) {
      if (!hasArchivedTitle(entry)) continue;
      addExpiredHistoryPaths(headActiveAndHistoryPaths, entry);
    }
  }

  const localeSlugCandidates = [];
  for (const [crawlerKey, rows] of baseActive) {
    for (const job of rows) {
      if (isHeld(job) || !job?.slugByLocale || typeof job.slugByLocale !== 'object') continue;
      const baseSlug = nonblank(job.slug) ? job.slug.trim() : '';
      const baseIdentifier = nonblank(job.id)
        ? job.id.trim()
        : baseSlug || `locale-slug:${crawlerKey}`;
      for (const [locale, value] of Object.entries(job.slugByLocale)) {
        if (!JOB_LOCALES.includes(locale) || !nonblank(value)) continue;
        const slug = value.trim();
        const routePath = activeJobPath(job, locale, slug);
        if (headActiveAndHistoryPaths.has(routePath)) continue;
        localeSlugCandidates.push({
          routePath,
          finding: {
            crawlerKey,
            locale,
            slug,
            path: routePath,
            baseIdentifier,
            baseSlug: baseSlug || slug,
          },
        });
      }
    }
  }
  const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  localeSlugCandidates.sort((a, b) => compareText(a.routePath, b.routePath)
    || compareText(a.finding.crawlerKey, b.finding.crawlerKey)
    || compareText(a.finding.baseIdentifier, b.finding.baseIdentifier)
    || compareText(a.finding.baseSlug, b.finding.baseSlug)
    || compareText(a.finding.slug, b.finding.slug));
  const activeLocaleSlugLost = [];
  const seenLocalePaths = new Set();
  for (const candidate of localeSlugCandidates) {
    if (seenLocalePaths.has(candidate.routePath)) continue;
    seenLocalePaths.add(candidate.routePath);
    activeLocaleSlugLost.push(candidate.finding);
  }

  const archiveLost = [];
  const seenLost = new Set();
  for (const [crawlerKey, rows] of baseExpired) {
    for (const entry of rows) {
      if (!nonblank(entry?.slug) || !hasArchivedTitle(entry)) continue;
      const slug = entry.slug.trim();
      if (served.has(slug) || seenLost.has(slug)) continue;
      seenLost.add(slug);
      archiveLost.push({ crawlerKey, slug, title: entry.title || '' });
    }
  }

  const countBy = (rows) => {
    const out = {};
    for (const row of rows) out[row.crawlerKey] = (out[row.crawlerKey] || 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
  };
  return {
    retired,
    retiredUnarchived,
    retiredUnarchivedByCrawler: countBy(retiredUnarchived),
    archiveLost,
    archiveLostByCrawler: countBy(archiveLost),
    activeLocaleSlugLost,
    activeLocaleSlugLostByCrawler: countBy(activeLocaleSlugLost),
  };
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

function sliceTree(rev, dir) {
  const out = git(['ls-tree', `${rev}:${dir}`]).trim();
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [meta, name] = line.split('\t');
    // `<key>.shard-NNN.json` belongs to `<key>` (expired-slice-store.mjs).
    return { oid: meta.split(' ')[2], key: expiredSliceKeyOf(name) ?? name.replace(/\.json$/u, ''), name };
  }).filter((entry) => isSliceFile(entry.name));
}

function prefetchMissing(oids, revisionRange) {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return;
  const check = git(['cat-file', '--batch-check'], {
    input: `${unique.join('\n')}\n`,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  const missing = check.split('\n').filter((line) => / missing$/u.test(line)).map((line) => line.split(' ')[0]);
  if (missing.length === 0) return;
  console.log(`📦 Backfilling ${missing.length} slice blob(s) through Git's promisor batches.`);
  backfillHistoryBlobs({ revisionRange });
  verifyPrefetchedBlobs(missing);
}

/** Streams blobs through one `git cat-file --batch` and parses each slice. */
function createBlobReader() {
  const child = spawn('git', ['cat-file', '--batch'], { cwd: ROOT });
  let buffer = Buffer.alloc(0);
  const waiting = [];
  const drain = () => {
    while (waiting.length > 0) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const header = buffer.subarray(0, newline).toString('utf8');
      if (/ missing$/u.test(header)) {
        buffer = buffer.subarray(newline + 1);
        waiting.shift().reject(new Error(`blob missing: ${header}`));
        continue;
      }
      const size = Number(header.split(' ')[2]);
      if (buffer.length < newline + 1 + size + 1) return;
      const body = buffer.subarray(newline + 1, newline + 1 + size);
      buffer = buffer.subarray(newline + 1 + size + 1);
      waiting.shift().resolve(body);
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  // An EOF or a failure of `git cat-file --batch` must reach every pending
  // read() at once; otherwise the run waits for the workflow timeout.
  let failure = null;
  const failAll = (error) => {
    failure = failure || error;
    while (waiting.length > 0) waiting.shift().reject(failure);
  };
  child.on('error', (error) => failAll(new Error(`git cat-file --batch failed: ${error.message}`)));
  child.stdout.on('end', () => failAll(new Error('git cat-file --batch closed its output before answering')));
  child.on('exit', (code, signal) => failAll(new Error(`git cat-file --batch exited (${signal || code})`)));
  child.stdin.on('error', (error) => failAll(new Error(`git cat-file --batch stdin: ${error.message}`)));
  return {
    read(oid) {
      return new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        waiting.push({ resolve, reject });
        child.stdin.write(`${oid}\n`);
      });
    },
    close() {
      child.stdin.end();
    },
  };
}

/**
 * Parse one slice blob. Same rule as readJsonFile (#18272): below the V8
 * string limit a plain parse, above it item-wise parsing of the array, and
 * never a silent `[]` — an unreadable slice stops the measurement.
 */
function rowsOf(bytes) {
  if (bytes.length > DEFAULT_JSON_STRING_LIMIT) {
    const decoder = new StringDecoder('utf8');
    const chunks = function* chunked() {
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        yield decoder.write(bytes.subarray(offset, offset + 1024 * 1024));
      }
      yield decoder.end();
    };
    return parseLargeJsonArray(chunks());
  }
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) return parsed.jobs;
  // Any other root is a malformed slice, not an empty one: counting it as
  // empty would let the observer pass on exactly the data it cannot judge.
  const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
  throw new Error(`unsupported slice root (${shape}${shape === 'object' ? ` with keys ${Object.keys(parsed).slice(0, 5).join(',') || 'none'}` : ''}); expected an array or {jobs: [...]}`);
}

/** Keep only the fields the measurement reads: slices weigh ~2 GB per revision. */
function slim(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    slug: row.slug,
    slugByLocale: row.slugByLocale,
    previousSlugs: row.previousSlugs,
    previousSlugsByLocale: row.previousSlugsByLocale,
    title: typeof row.title === 'string' ? row.title : undefined,
    titleByLocale: row.titleByLocale,
    id: row.id,
    company: row.company,
    location: row.location,
    canton: row.canton,
    // Judged on the whole row: the hold predicate reads more than this slim copy keeps.
    heldFromPublication: isHeldFromPublication(row),
  };
}

async function readRevision(reader, tree) {
  const out = new Map();
  for (const entry of tree) {
    try {
      const rows = rowsOf(await reader.read(entry.oid)).map(slim).filter(Boolean);
      // A sharded archive has several files per key: concatenate them.
      if (out.has(entry.key)) out.get(entry.key).push(...rows);
      else out.set(entry.key, rows);
    } catch (error) {
      throw new Error(`cannot read ${entry.name} (${entry.oid}): ${error.message}`);
    }
  }
  return out;
}

function parseArgs(argv) {
  const args = {
    head: 'HEAD',
    maxRetiredUnarchived: 0,
    maxArchiveLost: 0,
    maxActiveLocaleSlugLost: 0,
    json: '',
    prefetch: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => argv[++index];
    if (flag === '--base') args.base = value();
    else if (flag === '--head') args.head = value();
    else if (flag === '--max-retired-unarchived') args.maxRetiredUnarchived = Number(value());
    else if (flag === '--max-archive-lost') args.maxArchiveLost = Number(value());
    else if (flag === '--max-active-locale-slug-lost') args.maxActiveLocaleSlugLost = Number(value());
    else if (flag === '--json') args.json = value();
    else if (flag === '--prefetch') args.prefetch = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.base) throw new Error('--base <rev> is required');
  for (const key of ['maxRetiredUnarchived', 'maxArchiveLost', 'maxActiveLocaleSlugLost']) {
    if (!Number.isInteger(args[key]) || args[key] < 0) throw new Error(`invalid threshold for ${key}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const base = git(['rev-parse', '--verify', `${args.base}^{commit}`]).trim();
  const head = git(['rev-parse', '--verify', `${args.head}^{commit}`]).trim();
  const trees = {
    baseActive: sliceTree(base, ACTIVE_DIR),
    baseExpired: sliceTree(base, EXPIRED_DIR),
    headActive: sliceTree(head, ACTIVE_DIR),
    headExpired: sliceTree(head, EXPIRED_DIR),
  };
  if (args.prefetch) {
    prefetchMissing(
      Object.values(trees).flat().map((entry) => entry.oid),
      `${base}^..${head}`,
    );
  }

  const reader = createBlobReader();
  let result;
  try {
    const input = {};
    for (const [name, tree] of Object.entries(trees)) input[name] = await readRevision(reader, tree);
    result = measureRetiredArchiveCoverage(input);
  } finally {
    reader.close();
  }

  const report = {
    base,
    head,
    retired: result.retired,
    retiredUnarchived: result.retiredUnarchived.length,
    archiveLost: result.archiveLost.length,
    activeLocaleSlugLost: result.activeLocaleSlugLost.length,
    thresholds: {
      retiredUnarchived: args.maxRetiredUnarchived,
      archiveLost: args.maxArchiveLost,
      activeLocaleSlugLost: args.maxActiveLocaleSlugLost,
    },
    retiredUnarchivedByCrawler: result.retiredUnarchivedByCrawler,
    archiveLostByCrawler: result.archiveLostByCrawler,
    activeLocaleSlugLostByCrawler: result.activeLocaleSlugLostByCrawler,
    retiredUnarchivedSample: result.retiredUnarchived.slice(0, 50),
    archiveLostSample: result.archiveLost.slice(0, 50),
    activeLocaleSlugLostSample: result.activeLocaleSlugLost.slice(0, 50),
  };
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`🔎 Retired-job archive coverage ${base.slice(0, 12)}..${head.slice(0, 12)}`);
  console.log(`   rows retired from the active set: ${report.retired}`);
  console.log(`   retired WITHOUT an archive record with title: ${report.retiredUnarchived} (max ${args.maxRetiredUnarchived})`);
  console.log(`   archive records with title lost: ${report.archiveLost} (max ${args.maxArchiveLost})`);
  console.log(`   active locale slugs lost: ${report.activeLocaleSlugLost} (max ${args.maxActiveLocaleSlugLost})`);
  const top = (byCrawler) => Object.entries(byCrawler).slice(0, 15).map(([key, count]) => `${key}×${count}`).join(', ');
  if (report.retiredUnarchived > 0) console.log(`   retired-unarchived by crawler: ${top(report.retiredUnarchivedByCrawler)}`);
  if (report.archiveLost > 0) console.log(`   archive-lost by crawler: ${top(report.archiveLostByCrawler)}`);
  if (report.activeLocaleSlugLost > 0) console.log(`   active-locale-slug-lost by crawler: ${top(report.activeLocaleSlugLostByCrawler)}`);
  for (const row of result.retiredUnarchived.slice(0, 10)) console.log(`     ↳ retired ${row.crawlerKey}: ${row.slug}`);
  for (const row of result.archiveLost.slice(0, 10)) console.log(`     ↳ lost ${row.crawlerKey}: ${row.slug}`);
  for (const row of result.activeLocaleSlugLost.slice(0, 10)) {
    console.log(`     ↳ locale slug lost ${row.crawlerKey} [${row.locale}]: ${row.slug} (${row.path})`);
  }

  const retiredArchiveFailed = report.retiredUnarchived > args.maxRetiredUnarchived
    || report.archiveLost > args.maxArchiveLost;
  const localeSlugFailed = report.activeLocaleSlugLost > args.maxActiveLocaleSlugLost;
  if (retiredArchiveFailed) {
    console.error('❌ Job URLs left the active set without an expired soft-landing: the build will serve them as unverified stubs.');
    console.error('   Recovery: dispatch backfill-expired-from-history.yml (dry_run=false) for the crawlers above.');
  }
  if (localeSlugFailed) {
    console.error('❌ Active job locale routes lost their explicit slug without a matching route at head.');
  }
  return retiredArchiveFailed || localeSlugFailed ? 1 : 0;
}

if (isInvokedDirectly(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}

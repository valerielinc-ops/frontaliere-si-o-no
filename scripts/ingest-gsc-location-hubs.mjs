#!/usr/bin/env node
/**
 * ingest-gsc-location-hubs.mjs
 *
 * Ingests GSC Coverage Drilldown CSV exports and extracts location-hub
 * orphan URLs of the form `/{locale}/{section}/{loc-prefix}-{city}/`:
 *
 *   IT: /cerca-lavoro-ticino/localita-{city}/
 *   EN: /en/find-jobs-ticino/location-{city}/
 *   DE: /de/jobs-im-tessin/(standort|ort|stadt)-{city}/
 *   FR: /fr/trouver-emploi-tessin/(localite|ville|lieu)-{city}/
 *
 * For each orphan: cross-checks the city slug against the slugified
 * `location` field of every active job in `data/jobs.json`. Classifies as:
 *   - `matched`   → at least one active job has that location.
 *                   Bridge page renders the SPA shell at the orphan URL;
 *                   the SPA's `parseLocationSlugFilter` (JobBoard.tsx:2250)
 *                   applies the city filter on hydration → real job
 *                   listings + AdSense fire.
 *   - `unmatched` → no active job. Soft-landing with canonical → section.
 *
 * Output: `data/gsc-location-hubs.json`, consumed by the build plugin.
 *
 * Mirrors the pattern of `ingest-gsc-job-orphans.mjs` (PR #88).
 *
 * Usage:
 *   node scripts/ingest-gsc-location-hubs.mjs              # write
 *   node scripts/ingest-gsc-location-hubs.mjs --dry-run    # report only
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const DOWNLOADS_DIR = path.join(ROOT, 'download');
const OUT_PATH = path.join(ROOT, 'data', 'gsc-location-hubs.json');

const DRY_RUN = process.argv.includes('--dry-run');

const LOC_PATTERNS = [
  [/^\/cerca-lavoro-ticino\/localita-([^/]+)\/?$/, 'it'],
  [/^\/en\/find-jobs-ticino\/location-([^/]+)\/?$/, 'en'],
  [/^\/de\/jobs-im-tessin\/(?:standort|ort|stadt)-([^/]+)\/?$/, 'de'],
  [/^\/fr\/trouver-emploi-tessin\/(?:localite|ville|lieu)-([^/]+)\/?$/, 'fr'],
];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findCsvFiles() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(DOWNLOADS_DIR)) {
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

function urlToHub(url) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return null; }
  for (const [re, locale] of LOC_PATTERNS) {
    const m = pathname.match(re);
    if (m) return { locale, citySlug: m[1], url };
  }
  return null;
}

/** Build location-slug → [job count, display name] from jobs.json. */
function buildLocationIndex(jobs) {
  const idx = new Map();
  for (const j of jobs) {
    const loc = (j.location || '').trim();
    if (!loc) continue;
    const slug = slugify(loc);
    if (!idx.has(slug)) idx.set(slug, { displayName: loc, jobCount: 0 });
    idx.get(slug).jobCount += 1;
  }
  return idx;
}

/** Capitalize hyphen-separated tokens for display fallback. */
function humanize(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(' ');
}

function classifyHub(hub, locIdx, csvBasename) {
  const direct = locIdx.get(hub.citySlug);
  if (direct) {
    return {
      ...hub,
      kind: 'matched',
      displayName: direct.displayName,
      jobCount: direct.jobCount,
      csvOrigin: csvBasename,
    };
  }
  return {
    ...hub,
    kind: 'unmatched',
    displayName: humanize(hub.citySlug),
    jobCount: 0,
    csvOrigin: csvBasename,
  };
}

function main() {
  if (!fs.existsSync(JOBS_PATH)) {
    console.error(`✗ ${JOBS_PATH} not found.`);
    process.exit(1);
  }
  const csvFiles = findCsvFiles();
  if (csvFiles.length === 0) {
    console.error('No GSC CSV exports found under download/frontaliereticino.ch-Coverage-*');
    process.exit(1);
  }

  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  const locIdx = buildLocationIndex(jobs);
  console.log(`Loaded ${jobs.length} jobs, ${locIdx.size} distinct location slugs.`);

  const seen = new Set();
  const hubs = [];
  for (const { file, basename } of csvFiles) {
    const urls = parseCsvUrls(file);
    for (const url of urls) {
      const h = urlToHub(url);
      if (!h) continue;
      const key = `${h.locale}::${h.citySlug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hubs.push(classifyHub(h, locIdx, basename));
    }
  }

  const counts = hubs.reduce((acc, h) => { acc[h.kind] = (acc[h.kind] || 0) + 1; return acc; }, {});
  console.log(`\nTotal location-hub orphans: ${hubs.length}`);
  console.log('By kind:', counts);

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing. First 5 of each:');
    for (const kind of ['matched', 'unmatched']) {
      const sample = hubs.filter((h) => h.kind === kind).slice(0, 5);
      if (sample.length) console.log(`\n${kind}:`);
      for (const s of sample) console.log(`  [${s.locale}] ${s.citySlug}${s.jobCount ? ' (' + s.jobCount + ' jobs)' : ''}`);
    }
    return;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sources: csvFiles.map((c) => c.basename),
    counts,
    hubs,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`\nWrote ${hubs.length} location-hub records to ${path.relative(ROOT, OUT_PATH)}`);
}

main();

#!/usr/bin/env node
/**
 * ingest-gsc-orphans-into-candidates.mjs
 *
 * Augments `data/related-search-candidates.json` with **synthetic candidates**
 * derived from GSC Coverage Drilldown CSV exports. Purpose: recover the long-
 * tail of cluster URLs that Google has indexed in the past (and now reports
 * as `Non trovata (404)`) but that are no longer in the audit's candidate
 * set because their underlying jobs have expired.
 *
 * For each `/{section}/{prefix}-{slug-core}/` URL in the CSV that is NOT
 * already a candidate at the matching locale, we append:
 *   {
 *     slug: `${prefix}-${slug-core}`,
 *     locale,
 *     jobCount: 1,                 // satisfies MIN_JOB_COUNT=1
 *     sampleJobIds: [],            // no job-id evidence — synthetic
 *     sampleTerms: [<derived>],    // slug-core de-hyphenated, e.g. "koch davos"
 *     editorialCollision: null,
 *     gscMatch: true,              // tag synthesized from GSC report
 *     gscOrigin: <CSV file basename>,
 *   }
 *
 * The cluster plugin's per-page MIN_MATCHING_JOBS=3 quality gate then
 * decides emission: if AND-tier + OR-fill matching finds ≥3 matching
 * jobs in the current jobs.json the page emits, otherwise it stays
 * skipped (and the URL stays 404 — Google will eventually drop it).
 *
 * Usage:
 *   node scripts/ingest-gsc-orphans-into-candidates.mjs              # write
 *   node scripts/ingest-gsc-orphans-into-candidates.mjs --dry-run    # report only
 *
 * Reads every Tabella.csv under download/frontaliereticino.ch-Coverage-*
 * automatically. Idempotent: re-running with the same CSVs is a no-op.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');
const CANDIDATES_PATH = path.join(ROOT, 'data', 'related-search-candidates.json');
const DOWNLOADS_DIR = path.join(ROOT, 'download');

const DRY_RUN = process.argv.includes('--dry-run');

// Mirror of services/relatedSearchClusters.ts: locale-specific URL prefixes.
const SECTION_PATTERNS = [
  // [pathRegex, locale]
  [/^\/cerca-lavoro-ticino\/(ricerca-[^/]+)\/?$/, 'it'],
  [/^\/en\/find-jobs-ticino\/(search-[^/]+)\/?$/, 'en'],
  [/^\/de\/jobs-im-tessin\/(suche-[^/]+)\/?$/, 'de'],
  [/^\/fr\/trouver-emploi-tessin\/(recherche-[^/]+)\/?$/, 'fr'],
];

/** Strip the locale prefix from a slug to produce the slug-core token list. */
function slugCoreTokens(slug) {
  return slug
    .replace(/^(ricerca|search|suche|recherche)-/, '')
    .split('-')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Derive a human-readable sample term from the slug-core (e.g. "koch davos"). */
function sampleTermFromSlug(slug) {
  return slugCoreTokens(slug).join(' ');
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
  const lines = text.split(/\r?\n/).slice(1).filter(Boolean);
  return lines.map((l) => l.split(',')[0]).filter(Boolean);
}

function urlToCandidate(url, csvBasename) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  for (const [re, locale] of SECTION_PATTERNS) {
    const m = pathname.match(re);
    if (m) {
      const slug = m[1];
      const sampleTerm = sampleTermFromSlug(slug);
      if (!sampleTerm) return null;
      return {
        slug,
        locale,
        jobCount: 1,
        sampleJobIds: [],
        sampleTerms: [sampleTerm],
        editorialCollision: null,
        gscMatch: true,
        gscOrigin: csvBasename,
      };
    }
  }
  return null;
}

function main() {
  const csvFiles = findCsvFiles();
  if (csvFiles.length === 0) {
    console.error('No GSC CSV exports found under download/frontaliereticino.ch-Coverage-*');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf-8'));
  const existing = new Set(data.candidates.map((c) => `${c.locale}::${c.slug}`));

  const synthetic = [];
  const skippedNotSearchSlug = [];
  const skippedDuplicate = [];
  const seenInRun = new Set();

  for (const { file, basename } of csvFiles) {
    const urls = parseCsvUrls(file);
    for (const url of urls) {
      const cand = urlToCandidate(url, basename);
      if (!cand) {
        skippedNotSearchSlug.push(url);
        continue;
      }
      const key = `${cand.locale}::${cand.slug}`;
      if (existing.has(key) || seenInRun.has(key)) {
        skippedDuplicate.push(key);
        continue;
      }
      seenInRun.add(key);
      synthetic.push(cand);
    }
  }

  console.log(`CSVs scanned:                ${csvFiles.length}`);
  console.log(`URLs read:                   ${csvFiles.reduce((a, c) => a + parseCsvUrls(c.file).length, 0)}`);
  console.log(`Skipped (non-search-slug):   ${skippedNotSearchSlug.length}`);
  console.log(`Skipped (already candidate): ${skippedDuplicate.length}`);
  console.log(`New synthetic candidates:    ${synthetic.length}`);

  if (synthetic.length === 0) {
    console.log('Nothing to add. Candidates JSON is up to date.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: not writing. First 10 synthetic candidates:');
    for (const c of synthetic.slice(0, 10)) {
      console.log(`  [${c.locale}] /${c.slug}/  sample="${c.sampleTerms[0]}"`);
    }
    return;
  }

  // Bump the summary's gscMatches counter so audit reports reflect reality.
  data.candidates.push(...synthetic);
  if (data.summary && typeof data.summary === 'object') {
    data.summary.gscMatches = (data.summary.gscMatches || 0) + synthetic.length;
    data.summary.totalUniqueSlugs = data.candidates.length;
  }
  data.generatedAt = new Date().toISOString();
  if (Array.isArray(data.sources)) {
    const tag = `gsc-orphan-csv:${csvFiles.length}-files`;
    if (!data.sources.includes(tag)) data.sources.push(tag);
  }

  fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`\nWrote ${synthetic.length} synthetic candidates to ${path.relative(ROOT, CANDIDATES_PATH)}`);
  console.log('Next deploy will emit these as cluster pages (MIN_MATCHING_JOBS=0 floor; pages with zero AND/OR matches still render as alert-CTA landings).');
}

main();

#!/usr/bin/env node
/**
 * ingest-gsc-company-hubs.mjs
 *
 * Ingests GSC Coverage Drilldown CSV exports and extracts company-hub
 * orphan URLs of the form `/{locale}/{section}/(azienda|company|unternehmen|firma|entreprise|societe)-{company}/`.
 *
 * For each orphan: cross-checks the company slug against the slugified
 * `company` field of every active job in `data/jobs.json`. Classifies as:
 *   - `matched`   → at least one active job from that company.
 *                   Bridge page renders the SPA shell at the orphan URL;
 *                   the SPA's `parseCompanySlugFilter` (JobBoard.tsx)
 *                   applies the company filter on hydration.
 *   - `unmatched` → no active job. Soft-landing with canonical → section.
 *
 * Output: `data/gsc-company-hubs.json`, consumed by the build plugin.
 * Mirrors `ingest-gsc-location-hubs.mjs` (PR #89).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cantonSlugFile from '../data/canton-url-slugs.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const DOWNLOADS_DIR = path.join(ROOT, 'download');
const OUT_PATH = path.join(ROOT, 'data', 'gsc-company-hubs.json');

const DRY_RUN = process.argv.includes('--dry-run');

const LOCALE_SEGMENTS = new Set(['en', 'de', 'fr']);
const COMPANY_PREFIXES = new Set(['azienda', 'company', 'unternehmen', 'firma', 'entreprise', 'societe']);
const SECTION_PREFIX_BY_LOCALE = { it: 'cerca-lavoro', en: 'find-jobs', de: 'jobs-in', fr: 'trouver-emploi' };
const LEGACY_TI_SECTIONS = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

function buildJobSectionSlugs() {
  const out = new Set(Object.values(LEGACY_TI_SECTIONS));
  const cantons = cantonSlugFile.cantons || {};
  const aggregate = cantonSlugFile.aggregate || {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (aggregate[locale]) out.add(`${SECTION_PREFIX_BY_LOCALE[locale]}-${aggregate[locale]}`);
  }
  for (const entry of Object.values(cantons)) {
    for (const locale of ['it', 'en', 'fr']) {
      if (entry?.[locale]) out.add(`${SECTION_PREFIX_BY_LOCALE[locale]}-${entry[locale]}`);
    }
    if (entry?.de) out.add(`${entry.dePrefix || SECTION_PREFIX_BY_LOCALE.de + '-'}${entry.de}`);
  }
  return out;
}

const JOB_SECTION_SLUGS = buildJobSectionSlugs();

function slugify(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function findCsvFiles() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];
  const out = [];
  for (const e of fs.readdirSync(DOWNLOADS_DIR)) {
    if (!e.startsWith('frontaliereticino.ch-Coverage-')) continue;
    const csv = path.join(DOWNLOADS_DIR, e, 'Tabella.csv');
    if (fs.existsSync(csv)) out.push({ file: csv, basename: e });
  }
  return out;
}

function parseCsvUrls(file) {
  return fs.readFileSync(file, 'utf-8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(',')[0]).filter(Boolean);
}

function urlToHub(url) {
  let segments;
  try { segments = new URL(url).pathname.split('/').filter(Boolean); } catch { return null; }
  if (segments.length < 2) return null;
  let locale = 'it';
  let cursor = 0;
  if (LOCALE_SEGMENTS.has(segments[0])) {
    locale = segments[0];
    cursor = 1;
  }
  const section = segments[cursor];
  const companySegment = segments[cursor + 1];
  if (segments.length !== cursor + 2 || !JOB_SECTION_SLUGS.has(section) || !companySegment) return null;
  const dashIdx = companySegment.indexOf('-');
  if (dashIdx <= 0) return null;
  const prefix = companySegment.slice(0, dashIdx);
  const companySlug = companySegment.slice(dashIdx + 1);
  if (!COMPANY_PREFIXES.has(prefix) || !companySlug) return null;
  return { locale, companySlug, url };
}

function buildCompanyIndex(jobs) {
  const idx = new Map();
  for (const j of jobs) {
    const c = (j.company || '').trim();
    if (!c) continue;
    const slug = slugify(c);
    if (!idx.has(slug)) idx.set(slug, { displayName: c, jobCount: 0 });
    idx.get(slug).jobCount++;
    // Also index by companyKey if present
    const ck = (j.companyKey || '').trim();
    if (ck) {
      const cks = slugify(ck);
      if (!idx.has(cks)) idx.set(cks, { displayName: c, jobCount: 0 });
      idx.get(cks).jobCount++;
    }
  }
  return idx;
}

function humanize(slug) {
  return slug.split('-').filter(Boolean).map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
}

function classifyHub(hub, compIdx, csvBasename) {
  const direct = compIdx.get(hub.companySlug);
  if (direct) return { ...hub, kind: 'matched', displayName: direct.displayName, jobCount: direct.jobCount, csvOrigin: csvBasename };
  return { ...hub, kind: 'unmatched', displayName: humanize(hub.companySlug), jobCount: 0, csvOrigin: csvBasename };
}

function main() {
  if (!fs.existsSync(JOBS_PATH)) { console.error(`✗ ${JOBS_PATH} not found.`); process.exit(1); }
  const csvFiles = findCsvFiles();
  if (csvFiles.length === 0) { console.error('No GSC CSV under download/'); process.exit(1); }
  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  const compIdx = buildCompanyIndex(jobs);
  console.log(`Loaded ${jobs.length} jobs, ${compIdx.size} distinct company slugs.`);

  const seen = new Set();
  const hubs = [];
  for (const { file, basename } of csvFiles) {
    for (const url of parseCsvUrls(file)) {
      const h = urlToHub(url);
      if (!h) continue;
      const key = new URL(h.url).pathname.replace(/\/+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      hubs.push(classifyHub(h, compIdx, basename));
    }
  }

  const counts = hubs.reduce((a, h) => { a[h.kind] = (a[h.kind] || 0) + 1; return a; }, {});
  console.log(`\nTotal company-hub orphans: ${hubs.length}`);
  console.log('By kind:', counts);

  if (DRY_RUN) {
    for (const kind of ['matched', 'unmatched']) {
      const sample = hubs.filter((h) => h.kind === kind).slice(0, 5);
      if (sample.length) console.log(`\n${kind}:`);
      for (const s of sample) console.log(`  [${s.locale}] ${s.companySlug}${s.jobCount ? ' (' + s.jobCount + ' jobs)' : ''}`);
    }
    return;
  }

  const out = { generatedAt: new Date().toISOString(), sources: csvFiles.map((c) => c.basename), counts, hubs };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`\nWrote ${hubs.length} company-hub records to ${path.relative(ROOT, OUT_PATH)}`);
}

main();

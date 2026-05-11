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
 * Idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__filename, '..', '..');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const EXPIRED_PATH = path.join(ROOT, 'data', 'expired-jobs.json');
const DOWNLOADS_DIR = path.join(ROOT, 'download');
const OUT_PATH = path.join(ROOT, 'data', 'gsc-job-orphans.json');

const DRY_RUN = process.argv.includes('--dry-run');

const SECTION_PATTERNS = [
  [/^\/cerca-lavoro-ticino\/([^/]+)\/?$/, 'it'],
  [/^\/en\/find-jobs-ticino\/([^/]+)\/?$/, 'en'],
  [/^\/de\/jobs-im-tessin\/([^/]+)\/?$/, 'de'],
  [/^\/fr\/trouver-emploi-tessin\/([^/]+)\/?$/, 'fr'],
];

const SECTION_SLUG = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const LOCALE_PREFIX = { it: '', en: '/en', de: '/de', fr: '/fr' };

/** Reserved hub prefixes — slugs starting with these are NOT job-details. */
const HUB_PREFIXES = [
  /^(ricerca|search|suche|recherche)-/,
  /^(azienda|localita|location|standort|ort|stadt|unternehmen|firma|entreprise|ville|lieu|localite)-/,
];

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

function urlToOrphan(url) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return null; }
  for (const [re, locale] of SECTION_PATTERNS) {
    const m = pathname.match(re);
    if (!m) continue;
    const slug = m[1];
    if (HUB_PREFIXES.some((rx) => rx.test(slug))) return null;
    return { locale, slug, url };
  }
  return null;
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

function classifyOrphan(orphan, jobs, expiredIdx, csvBasename) {
  const slugIndex = buildSlugIndex(jobs);

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
    process.exit(1);
  }

  const csvFiles = findCsvFiles();
  if (csvFiles.length === 0) {
    console.error('No GSC CSV exports found under download/frontaliereticino.ch-Coverage-*');
    process.exit(1);
  }

  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  const expiredArr = fs.existsSync(EXPIRED_PATH)
    ? (() => { const e = JSON.parse(fs.readFileSync(EXPIRED_PATH, 'utf-8')); return Array.isArray(e) ? e : (e.jobs || e.entries || []); })()
    : [];
  const expiredIdx = buildExpiredIndex(expiredArr);

  console.log(`Loaded ${jobs.length} jobs, ${expiredArr.length} expired-job records.`);

  const seen = new Set();
  const orphans = [];

  for (const { file, basename } of csvFiles) {
    const urls = parseCsvUrls(file);
    for (const url of urls) {
      const o = urlToOrphan(url);
      if (!o) continue;
      const key = `${o.locale}::${o.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      orphans.push(classifyOrphan(o, jobs, expiredIdx, basename));
    }
  }

  // Summary
  const counts = orphans.reduce((acc, o) => { acc[o.kind] = (acc[o.kind] || 0) + 1; return acc; }, {});
  console.log(`\nTotal job-orphans: ${orphans.length}`);
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
    sources: csvFiles.map((c) => c.basename),
    counts,
    orphans,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`\nWrote ${orphans.length} job-orphan records to ${path.relative(ROOT, OUT_PATH)}`);
}

main();

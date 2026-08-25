#!/usr/bin/env node
/**
 * Auto-generate company entries for the companies directory page
 * from crawler infrastructure.
 *
 * Sources:
 *   1. COMPANY_HQ registry (crawler-location-config.mjs) — slugs + locations
 *   2. Job slices (data/jobs/by-crawler/{slug}.json) — company name + domain
 *   3. Runner/parser files — fallback for name/domain extraction
 *
 * Output: data/crawler-companies-auto.json
 *
 * Run after scaffolding new crawlers or during assemble step.
 * The TicinoCompanies component imports this file and merges it with
 * hardcoded + manual entries, so deduplication handles overlaps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SLICES_DIR = path.resolve(ROOT, 'data', 'jobs', 'by-crawler');
const RUNNERS_DIR = path.resolve(ROOT, 'scripts');
const PARSERS_DIR = path.resolve(ROOT, 'scripts', 'lib');
const OUTPUT = path.resolve(ROOT, 'data', 'crawler-companies-auto.json');

// ─── Import COMPANY_HQ ─────────────────────────────────────────────────────
const { COMPANY_HQ } = await import('./lib/crawler-location-config.mjs');
const { registrableDomain } = await import('./lib/prospector/registrable.mjs');

// ─── Discover all crawler slugs from runner files ───────────────────────────
function discoverCrawlerSlugs() {
  const files = fs.readdirSync(RUNNERS_DIR).filter(
    (f) => f.startsWith('update-') && f.endsWith('-jobs.mjs')
  );
  return files.map((f) => f.replace(/^update-/, '').replace(/-jobs\.mjs$/, ''));
}

// ─── Locate the slice a runner actually writes ──────────────────────────────
/**
 * The runner FILENAME gives `update-<slug>-jobs.mjs` -> `<slug>`, but the slice
 * is named after the runner's INTERNAL company key, and the two diverge freely:
 * `update-eoc-jobs.mjs` declares `EOC_KEY = 'eoc-ente-ospedaliero-cantonale'`
 * and writes `eoc-ente-ospedaliero-cantonale.json`. Measured on this repo, 87
 * of the runners have no same-named slice.
 *
 * Looking for `<slug>.json` alone therefore misses silently and falls back to
 * regex-scraping the runner source, which finds a name but rarely a domain —
 * that is how the `eoc` entry ended up with no `website` at all, and how the
 * prospector lost its only chance to recognise EOC by domain.
 *
 * Resolution order, deterministic and never a guess:
 *   1. `<slug>.json`
 *   2. exactly one slice named `<slug>-*.json`
 *   3. otherwise nothing — ambiguity (`migros` -> `migros-hq`, `migros-ticino`)
 *      falls back to the source scrape rather than picking a sibling at random.
 *
 * @param {string} slug
 * @returns {string|null} absolute path to the slice, or null
 */
function resolveSlicePath(slug) {
  const exact = path.join(SLICES_DIR, `${slug}.json`);
  if (fs.existsSync(exact)) return exact;

  let entries;
  try {
    entries = fs.readdirSync(SLICES_DIR);
  } catch {
    return null; // slices not materialised in a sparse checkout
  }
  const matches = entries.filter(
    (f) =>
      f.endsWith('.json') &&
      f.startsWith(`${slug}-`) &&
      // Scratch/cache companions are the same crawler's working files, not a
      // second employer — they must not make a lookup look ambiguous.
      !/-(locale-cache|cache|scratch|raw)\.json$/.test(f),
  );
  return matches.length === 1 ? path.join(SLICES_DIR, matches[0]) : null;
}

// ─── Read company metadata from job slice ───────────────────────────────────
function readFromSlice(slug) {
  const slicePath = resolveSlicePath(slug);
  if (!slicePath) return null;
  try {
    const data = JSON.parse(fs.readFileSync(slicePath, 'utf8'));
    const jobs = Array.isArray(data) ? data : data?.jobs || [];
    if (!jobs.length) return null;
    const job = jobs[0];
    return {
      company: job.company || '',
      companyDomain: job.companyDomain || '',
    };
  } catch {
    return null;
  }
}

// ─── Reject a VENDOR domain posing as the employer's own ────────────────────
/** Registrable domains of every hosted-ATS platform the prospector knows. */
const VENDOR_DOMAINS = (() => {
  const out = new Set();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'prospector', 'platforms.json'), 'utf8'));
  } catch {
    // Registry absent (sparse checkout): the guard lets everything through
    // rather than pretending every domain is fine.
    console.warn('⚠️  platforms.json non leggibile — guardia vendor-domain inattiva.');
    return out;
  }
  // `platforms` is an OBJECT keyed by domain, not an array. Iterating it as an
  // array throws, and swallowing that in a catch left the guard silently empty
  // — the failure mode this whole file exists to stop.
  const platforms = raw?.platforms;
  const list = Array.isArray(platforms) ? platforms : Object.values(platforms || {});
  for (const p of list) {
    const d = registrableDomain(typeof p === 'string' ? p : p?.domain || '');
    if (d) out.add(d);
  }
  if (!out.size) console.warn('⚠️  nessun dominio vendor indicizzato da platforms.json — guardia inattiva.');
  return out;
})();

/**
 * `apply.workable.com` is where GUESS publishes, not who GUESS is. Recording it
 * as the company domain puts `workable.com` into the prospector's coverage index,
 * where — folded to the registrable domain — it marks every OTHER Workable
 * tenant as an employer we already crawl, and discovery dies silently. Three
 * entries were already in this state (`boggi`, `guess`, `vir-biotechnology`)
 * before the slice lookup above started finding many more domains.
 *
 * @param {string} domain
 * @returns {boolean}
 */
function isVendorDomain(domain) {
  const d = registrableDomain(domain || '');
  return Boolean(d) && VENDOR_DOMAINS.has(d);
}

// ─── Regex-extract company metadata from runner or parser file ──────────────
function extractFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const src = fs.readFileSync(filePath, 'utf8');
    const result = {};

    // Try multiple patterns for company name
    const namePatterns = [
      /(?:COMPANY_NAME|companyLabel)\s*[:=]\s*['"`]([^'"`]+)['"`]/,
      /const\s+\w+_COMPANY_NAME\s*=\s*['"`]([^'"`]+)['"`]/,
      /company:\s*['"`]([^'"`]+)['"`]/,
    ];
    for (const pat of namePatterns) {
      const m = src.match(pat);
      if (m) { result.company = m[1]; break; }
    }

    // Try multiple patterns for domain
    const domainPatterns = [
      /(?:COMPANY_DOMAIN|COMPANY_HOST|companyDomain)\s*[:=]\s*['"`]([^'"`]+)['"`]/,
      /const\s+\w+_COMPANY_DOMAIN\s*=\s*['"`]([^'"`]+)['"`]/,
    ];
    for (const pat of domainPatterns) {
      const m = src.match(pat);
      if (m) { result.companyDomain = m[1]; break; }
    }

    // Try to extract careers URL
    const careersPatterns = [
      /CAREERS_URL\s*=\s*['"`]([^'"`]+)['"`]/,
      /careersUrl\s*[:=]\s*['"`]([^'"`]+)['"`]/,
    ];
    for (const pat of careersPatterns) {
      const m = src.match(pat);
      if (m) { result.careersUrl = m[1]; break; }
    }

    return result;
  } catch {
    return {};
  }
}

// ─── Prettify a slug into a human-readable name ─────────────────────────────
function slugToName(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Main ───────────────────────────────────────────────────────────────────
const slugs = discoverCrawlerSlugs();
const companies = [];
const seen = new Set();

for (const slug of slugs) {
  // Skip aliases in COMPANY_HQ (they point to the same company)
  if (seen.has(slug)) continue;
  seen.add(slug);

  // Location from COMPANY_HQ
  const hq = COMPANY_HQ[slug];

  // Company metadata: try slice first, then runner, then parser
  const sliceData = readFromSlice(slug);
  const runnerData = extractFromFile(path.join(RUNNERS_DIR, `update-${slug}-jobs.mjs`));
  const parserData = extractFromFile(path.join(PARSERS_DIR, `${slug}-job-parser.mjs`));

  const companyName =
    sliceData?.company ||
    runnerData?.company ||
    parserData?.company ||
    slugToName(slug);

  const companyDomain =
    [sliceData?.companyDomain, runnerData?.companyDomain, parserData?.companyDomain]
      .find((d) => d && !isVendorDomain(d)) || '';

  const careersUrl = runnerData?.careersUrl || parserData?.careersUrl || '';
  const website = companyDomain
    ? `https://www.${companyDomain.replace(/^www\./, '')}`
    : '';

  const entry = {
    name: companyName,
    key: slug,
    website: website || undefined,
    careersUrl: careersUrl || undefined,
    city: hq?.city || 'Lugano',
    canton: hq?.canton || 'TI',
    country: 'CH',
    hasDedicatedCrawler: true,
    autoGenerated: true,
  };

  // Clean undefined values
  Object.keys(entry).forEach((k) => {
    if (entry[k] === undefined) delete entry[k];
  });

  companies.push(entry);
}

// Sort alphabetically by name
companies.sort((a, b) => a.name.localeCompare(b.name, 'it'));

fs.writeFileSync(OUTPUT, JSON.stringify(companies, null, 2) + '\n', 'utf8');

console.log(`✅ Generated ${companies.length} crawler company entries → ${path.relative(ROOT, OUTPUT)}`);

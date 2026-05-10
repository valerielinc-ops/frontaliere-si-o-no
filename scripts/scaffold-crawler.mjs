#!/usr/bin/env node
/**
 * Scaffold a new job crawler — generates all 4 required files.
 *
 * Usage:
 *   node scripts/scaffold-crawler.mjs <company-key> [options]
 *   node scripts/scaffold-crawler.mjs --marquee <slug> [options]
 *
 * Examples:
 *   node scripts/scaffold-crawler.mjs my-company
 *   node scripts/scaffold-crawler.mjs my-company --name "My Company SA" --domain mycompany.ch --lang de --ats workday
 *   node scripts/scaffold-crawler.mjs roche --ats workday --url "https://roche.wd3.myworkdayjobs.com/roche"
 *   node scripts/scaffold-crawler.mjs --marquee credit-suisse        # auto-pull name/canton/ats from marquee list
 *
 * Options:
 *   --name        Company display name (default: Title Case of key)
 *   --domain      Company website domain (default: {key}.ch)
 *   --lang        Source language: it, en, de, fr (default: it)
 *   --ats         ATS tier: workday | greenhouse | lever | successfactors | custom (default: custom)
 *   --source      Legacy alias for --ats. Old `generic|api` values map to --ats=custom.
 *   --url         Career page URL (used in parser template)
 *   --marquee     Slug from data/marquee-companies-list.json — auto-pulls name/hq_canton/hq_city/ats_hint/careerUrl
 *   --playwright  Workflow installs Chromium (for SPA / JS-only ATS pages)
 *   --force       Overwrite existing files
 *
 * Generated files:
 *   1. scripts/lib/{key}-job-parser.mjs        — Parser (ATS-aware when --ats != custom; ~50 lines instead of ~200)
 *   2. scripts/update-{key}-jobs.mjs           — Runner (30-line entry point)
 *   3. .github/workflows/update-jobs-{key}.yml — GitHub Actions workflow
 *   4. tests/{key}-crawler.test.ts             — Parser unit tests
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ── CLI Parsing ─────────────────────────────────────────────── */

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
Usage: node scripts/scaffold-crawler.mjs <company-key> [options]
       node scripts/scaffold-crawler.mjs --marquee <slug> [options]

Options:
  --name <name>       Company display name (e.g. "Lonza AG")
  --domain <domain>   Company domain (e.g. "lonza.com")
  --lang <code>       Source language: it, en, de, fr (default: it)
  --ats <tier>        ATS tier: workday | greenhouse | lever | successfactors | custom (default: custom)
  --source <type>     Legacy alias for --ats (deprecated)
  --url <url>         Career page URL
  --marquee <slug>    Auto-pull name/canton/city/ats_hint/careerUrl from data/marquee-companies-list.json
  --playwright        Workflow installs Chromium (for SPA / JS-only ATS pages)
  --force             Overwrite existing files

Examples:
  node scripts/scaffold-crawler.mjs hes-so-valais --name "HES-SO Valais" --domain hes-so.ch --lang fr --url "https://www.hes-so.ch/careers"
  node scripts/scaffold-crawler.mjs roche --ats workday --url "https://roche.wd3.myworkdayjobs.com/roche"
  node scripts/scaffold-crawler.mjs --marquee credit-suisse
`);
  process.exit(0);
}

/**
 * Get a CLI option value by flag name. Supports both `--flag value` and
 * `--flag=value` forms.
 *
 * @param {string} flag
 * @param {string} [defaultValue='']
 * @returns {string}
 */
function getOption(flag, defaultValue = '') {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === flag) return args[i + 1] || defaultValue;
    if (a && a.startsWith(eqPrefix)) return a.slice(eqPrefix.length) || defaultValue;
  }
  return defaultValue;
}

/**
 * Look up a company entry in `data/marquee-companies-list.json` by slug.
 * Saves typing on `--name`, `--domain`, `--ats`, and `--url` for the
 * curated 119-company marquee list.
 *
 * @param {string} slug Lower-case slug (e.g. `'credit-suisse'`).
 * @returns {object|null} Marquee record or null when missing/unreadable.
 */
function loadMarqueeEntry(slug) {
  if (!slug) return null;
  const file = path.join(ROOT, 'data', 'marquee-companies-list.json');
  if (!fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const list = Array.isArray(json?.companies) ? json.companies : [];
    const want = slug.toLowerCase();
    return list.find((c) => String(c?.slug_suggestion || '').toLowerCase() === want) || null;
  } catch (err) {
    console.warn(`⚠️  Could not read marquee-companies-list.json: ${err?.message || err}`);
    return null;
  }
}

/**
 * Map a marquee `ats_hint` string (e.g. `'Workday'`, `'SAP SuccessFactors'`,
 * `'Greenhouse'`, `'Lever'`, `'?'`) to the canonical `--ats` tier slug.
 *
 * @param {string} hint
 * @returns {'workday'|'greenhouse'|'lever'|'successfactors'|'custom'}
 */
function normalizeAtsHint(hint) {
  const h = String(hint || '').toLowerCase();
  if (/workday/.test(h)) return 'workday';
  if (/greenhouse/.test(h)) return 'greenhouse';
  if (/lever/.test(h)) return 'lever';
  if (/success ?factors|sap.*sf|^sf$/.test(h)) return 'successfactors';
  return 'custom';
}

const VALID_ATS_TIERS = new Set(['workday', 'greenhouse', 'lever', 'successfactors', 'custom']);

// First pass: resolve --marquee so its values can act as defaults below.
const marqueeSlug = getOption('--marquee', '').toLowerCase();
const marquee = marqueeSlug ? loadMarqueeEntry(marqueeSlug) : null;
if (marqueeSlug && !marquee) {
  console.error(`❌ No marquee entry found for slug "${marqueeSlug}" in data/marquee-companies-list.json.`);
  process.exit(1);
}

// Company key: positional arg first; fall back to --marquee slug.
const positional = args[0] && !args[0].startsWith('--') ? args[0] : '';
const rawKey = positional || marqueeSlug;
const companyKey = rawKey.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
if (!companyKey || companyKey.length < 2) {
  console.error('❌ Company key must be at least 2 characters (kebab-case). Pass it as the first arg or via --marquee.');
  process.exit(1);
}

const force = args.includes('--force');
const playwrightTier = args.includes('--playwright');

const companyName =
  getOption('--name') ||
  marquee?.name ||
  companyKey.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const companyDomain = getOption('--domain') || `${companyKey.replace(/-/g, '')}.ch`;
const sourceLang = getOption('--lang', 'it');

// --ats wins; --source is the legacy alias. Marquee `ats_hint` is the
// fallback. Anything not in VALID_ATS_TIERS (e.g. legacy `generic`/`api`)
// degrades to 'custom' so backward compatibility is preserved.
const atsRaw = (getOption('--ats', '') || getOption('--source', '')).toLowerCase();
let atsTier = atsRaw;
if (!atsTier && marquee?.ats_hint) atsTier = normalizeAtsHint(marquee.ats_hint);
if (!atsTier) atsTier = 'custom';
if (!VALID_ATS_TIERS.has(atsTier)) atsTier = 'custom';

// Legacy `sourceType` retained for the API-template fallback when --ats=custom
// (preserves the original `--source api` paginated stub).
const sourceType = getOption('--source', 'generic');

const careerUrl =
  getOption('--url') ||
  marquee?.careerUrl ||
  `https://${companyDomain}/careers`;

const CONST_PREFIX = companyKey.toUpperCase().replace(/-/g, '_');
const camelKey = companyKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const pascalKey = camelKey.charAt(0).toUpperCase() + camelKey.slice(1);

if (marquee) {
  console.log(
    `🎯 Marquee match: ${marquee.name} (${marquee.hq_canton || '?'}/${marquee.hq_city || '?'}, ` +
    `ats_hint="${marquee.ats_hint || '?'}" → --ats=${atsTier})`,
  );
}

/* ── File Paths ──────────────────────────────────────────────── */

const files = {
  parser: path.join(ROOT, 'scripts', 'lib', `${companyKey}-job-parser.mjs`),
  runner: path.join(ROOT, 'scripts', `update-${companyKey}-jobs.mjs`),
  workflow: path.join(ROOT, '.github', 'workflows', `update-jobs-${companyKey}.yml`),
  test: path.join(ROOT, 'tests', `${companyKey}-crawler.test.ts`),
};

/* ── Existence Check ─────────────────────────────────────────── */

if (!force) {
  const existing = Object.entries(files).filter(([, p]) => fs.existsSync(p));
  if (existing.length > 0) {
    console.error('❌ Files already exist (use --force to overwrite):');
    existing.forEach(([type, p]) => console.error(`   ${type}: ${path.relative(ROOT, p)}`));
    process.exit(1);
  }
}

/* ── ATS-tier Parser Section Builder ─────────────────────────── */

/**
 * Produce the ATS-specific imports + `fetchJobListings()` body for the
 * generated parser. Each branch is a thin shim around the corresponding
 * `scripts/lib/ats-clients/*-client.mjs` module — the goal is ~50 lines
 * of generated parser code (vs ~200 for the legacy from-scratch template).
 *
 * The returned `fetchBlock` MUST define a top-level `async function
 * fetchJobListings()` that returns an array of plain listing objects with
 * at least `{ title, location, url }`. The post-fetch loop in the parser
 * template (slug + locale + Job-shape assembly) consumes that array and
 * is identical for every ATS tier.
 *
 * @param {string} tier 'workday' | 'greenhouse' | 'lever' | 'successfactors' | 'custom'
 * @returns {{ imports: string, fetchBlock: string }}
 */
function buildAtsParserSection(tier) {
  if (tier === 'workday') {
    return {
      imports: `import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';`,
      fetchBlock: `/* ── Workday fetcher ──────────────────────────────────────────
 * The career URL must point to a Workday CXS site, e.g.:
 *   https://{tenant}.wd3.myworkdayjobs.com/{site}
 * Switzerland location filter ID varies per tenant — inspect the network
 * tab on the live site to find the correct facet value.
 */
const _WORKDAY_URL = new URL(CAREER_URL);
const WORKDAY_TENANT_HOST = _WORKDAY_URL.hostname;
const WORKDAY_SITE_PATH = (_WORKDAY_URL.pathname.replace(/^\\/+|\\/+$/g, '').split('/').pop()) || 'External';
const WORKDAY_LOCATION_FILTERS = []; // TODO: e.g. ['187134fccb084a0ea9b4b95f23890dbe'] for CH on most tenants

async function fetchJobListings() {
  const apiBase = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(apiBase, {
      locationFilters: WORKDAY_LOCATION_FILTERS,
      maxPages: 10,
    })) {
      const id = extractWorkdayJobIdentity(posting, { apiBase, company: ${CONST_PREFIX}_COMPANY_NAME });
      out.push({
        title: id.title,
        location: id.location,
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(\`❌ Workday anti-bot block: \${err.message}\`);
      return [];
    }
    throw err;
  }
  return out;
}`,
    };
  }

  if (tier === 'greenhouse') {
    return {
      imports: `import {
  fetchGreenhouseJobs,
  extractGreenhouseBoardToken,
} from './ats-clients/greenhouse-client.mjs';`,
      fetchBlock: `/* ── Greenhouse fetcher ───────────────────────────────────────
 * Pass either a boards.greenhouse.io URL (auto-extracts board token) or
 * override GREENHOUSE_BOARD_TOKEN below. Location filter is a list of
 * substrings matched (case-insensitive) against \`location.name\`.
 */
const GREENHOUSE_BOARD_TOKEN =
  extractGreenhouseBoardToken(CAREER_URL) || ${CONST_PREFIX}_KEY;
const GREENHOUSE_LOCATION_CONTAINS = []; // TODO: e.g. ['Switzerland', 'Zurich', 'Lausanne']

async function fetchJobListings() {
  const jobs = await fetchGreenhouseJobs(GREENHOUSE_BOARD_TOKEN, {
    includeContent: true,
    locationContains: GREENHOUSE_LOCATION_CONTAINS,
    companyName: ${CONST_PREFIX}_COMPANY_NAME,
  });
  return jobs.map((j) => ({
    title: j.title,
    location: j.location,
    url: j.applyUrl,
    postedAt: j.postedAt,
    description: j.descriptionHtml || '',
    jobReqId: j.jobReqId,
  }));
}`,
    };
  }

  if (tier === 'lever') {
    return {
      imports: `import {
  fetchLeverJobs,
  extractLeverCompanySlug,
} from './ats-clients/lever-client.mjs';`,
      fetchBlock: `/* ── Lever fetcher ────────────────────────────────────────────
 * Pass either a jobs.lever.co URL (auto-extracts company slug) or
 * override LEVER_COMPANY_SLUG below.
 */
const LEVER_COMPANY_SLUG =
  extractLeverCompanySlug(CAREER_URL) || ${CONST_PREFIX}_KEY;
const LEVER_LOCATION_CONTAINS = []; // TODO: e.g. ['switzerland', 'zurich']

async function fetchJobListings() {
  const jobs = await fetchLeverJobs(LEVER_COMPANY_SLUG, {
    company: ${CONST_PREFIX}_COMPANY_NAME,
    locationContains: LEVER_LOCATION_CONTAINS,
  });
  return jobs.map((j) => ({
    title: j.title,
    location: j.location,
    url: j.applyUrl,
    postedAt: j.postedAt,
    description: j.descriptionHtml || '',
    jobReqId: j.jobReqId,
  }));
}`,
    };
  }

  if (tier === 'successfactors') {
    return {
      imports: `import {
  detectSuccessFactorsKind,
  fetchSuccessFactorsJobs,
  SuccessFactorsAuthError,
} from './ats-clients/successfactors-client.mjs';`,
      fetchBlock: `/* ── SuccessFactors fetcher ───────────────────────────────────
 * Three flavors auto-detected from CAREER_URL:
 *   - 'odata-api'    → api{N}.successfactors.com/odata/v2/...
 *   - 'html-career'  → career5.successfactors.eu/career?company=...
 *   - 'html-jobreq'  → jobs2web / SSR overlay (jobs.sbb.ch, etc.)
 * For 'html-career' listing index you typically need Playwright
 * (re-scaffold with --playwright if so).
 */
const SF_LOCATION_FILTERS = []; // TODO: e.g. ['Ticino', 'Lugano', 'Zurich']

async function fetchJobListings() {
  const kind = detectSuccessFactorsKind(CAREER_URL);
  if (!kind) {
    console.warn(\`⚠️ URL not recognised as SuccessFactors: \${CAREER_URL}\`);
    return [];
  }
  const out = [];
  try {
    for await (const job of fetchSuccessFactorsJobs(CAREER_URL, {
      locationFilters: SF_LOCATION_FILTERS,
      company: ${CONST_PREFIX}_COMPANY_NAME,
    })) {
      out.push({
        title: job.title,
        location: job.location,
        url: job.applyUrl,
        postedAt: job.postedAt,
        jobReqId: job.jobReqId,
      });
    }
  } catch (err) {
    if (err instanceof SuccessFactorsAuthError) {
      console.error(\`❌ SuccessFactors anti-bot block: \${err.message}\`);
      return [];
    }
    throw err;
  }
  return out;
}`,
    };
  }

  // tier === 'custom' (default): empty marker — caller falls back to legacy
  // `sourceType === 'api'` API-paginated stub or generic fetch placeholder.
  return { imports: '', fetchBlock: '' };
}

const atsSection = buildAtsParserSection(atsTier);

/* ── Template: Parser ────────────────────────────────────────── */

const parserContent = `#!/usr/bin/env node
/**
 * ${companyName} job parser — Fetcher and job builder.
 *
 * Source: ${careerUrl}
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAll${pascalKey}Jobs()  — Fetch and parse all jobs
 *   - is${pascalKey}Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
${atsSection.imports ? `${atsSection.imports}\n` : ''}
/* ── Constants ─────────────────────────────────────────────── */

export const ${CONST_PREFIX}_KEY = '${companyKey}';
export const ${CONST_PREFIX}_COMPANY_NAME = '${companyName}';
export const ${CONST_PREFIX}_COMPANY_DOMAIN = '${companyDomain}';

const CAREER_URL = '${careerUrl}';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to ${companyName}.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function is${pascalKey}Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ${CONST_PREFIX}_KEY ||
    key.startsWith('${companyKey}') ||
    company.includes('${companyName.toLowerCase()}') ||
    url.includes('${companyDomain}')
  );
}

/**
 * Validate that a URL belongs to ${companyName}'s domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === '${companyDomain}' || host.endsWith('.${companyDomain}');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\\b(junior|jr)/.test(t)) return 'junior';
  if (/\\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

${atsSection.fetchBlock ? atsSection.fetchBlock : (sourceType === 'api' ? `/* ── API Client ────────────────────────────────────────────── */

const PAGE_SIZE = 20; // TODO: Adjust to match the API's page size

/**
 * Call the JSON API with timeout handling.
 */
async function callApi(url, body = null) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const opts = {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    clearTimeout(timer);
    if (!res.ok) throw new Error(\`HTTP \${res.status} from API\`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch paginated job listings from the API.
 * TODO: Adapt pagination to match the actual API (offset, cursor, page number, etc.)
 */
async function fetchJobListings() {
  const allListings = [];
  let offset = 0;

  while (true) {
    console.log(\`  📄 Fetching page at offset \${offset}...\`);
    // TODO: Adjust URL/body to match the actual API pagination
    const data = await callApi(\`\${CAREER_URL}?offset=\${offset}&limit=\${PAGE_SIZE}\`);
    const items = data?.results || data?.jobs || data || [];
    if (!Array.isArray(items) || items.length === 0) break;
    allListings.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  return allListings;
}

/**
 * Fetch detail for a single job (richer description).
 * TODO: Implement if the API provides a separate detail endpoint.
 */
async function fetchJobDetail(jobId) {
  // const data = await callApi(\`\${CAREER_URL}/\${jobId}\`);
  // return data;
  return null;
}` : `/* ── Fetch + Parse ─────────────────────────────────────────── */

// TODO: Implement the actual fetching logic for ${companyName}'s career page.
// This is a placeholder. Replace with the actual API/scraping logic.
//
// Common patterns:
//   - JSON API:     use --source api for a ready-made paginated API template
//   - Workday API:  re-scaffold with --ats=workday for a ready-made template
//   - Greenhouse:   --ats=greenhouse
//   - Lever:        --ats=lever
//   - SuccessFactors: --ats=successfactors
//   - Generic HTML: fetch + parse with regex or cheerio

async function fetchJobListings() {
  // TODO: Replace with actual fetch logic
  console.log(\`   Fetching from: \${CAREER_URL}\`);

  // Example for a JSON API:
  // const res = await fetch(CAREER_URL, {
  //   headers: { 'User-Agent': 'FrontaliereTicino-JobCrawler/2.0' },
  // });
  // if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  // return await res.json();

  return [];
}`)}

/**
 * Fetch all ${companyName} jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAll${pascalKey}Jobs() {
  console.log(\`🔍 Fetching ${companyName} jobs\`);
  console.log(\`   Source: \${CAREER_URL}\\n\`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(\`  📋 Listings found: \${listings.length}\`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Lugano'; // TODO: extract actual location
    const canton = inferSwissTargetCanton(location) || 'TI';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, '${sourceLang}');
    const jobSlug = slugify(\`\${title} ${companyKey} ch\`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: \`${companyKey}-\${urlHash}\`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ${CONST_PREFIX}_COMPANY_NAME,
      companyKey: ${CONST_PREFIX}_KEY,
      companyDomain: ${CONST_PREFIX}_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || \`\${title} — ${companyName}\`,
      descriptionByLocale: { [sourceLang]: descriptionText || \`\${title} — ${companyName}\` },
      location,
      canton,
      url: publicUrl,
      source: '${companyName} Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(\`\\n📋 Total ${companyName} jobs discovered: \${jobs.length}\`);
  return jobs;
}
`;

/* ── Template: Runner ────────────────────────────────────────── */

const runnerContent = `#!/usr/bin/env node
/**
 * Dedicated ${companyName} crawler runner.
 *
 * Uses the standard crawler template with the ${companyName} parser.
 * All fetch/parse logic lives in ./lib/${companyKey}-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAll${pascalKey}Jobs,
  is${pascalKey}Job,
  isTrustedDomain,
  ${CONST_PREFIX}_KEY,
  ${CONST_PREFIX}_COMPANY_NAME,
} from './lib/${companyKey}-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ${CONST_PREFIX}_KEY,
  companyLabel: ${CONST_PREFIX}_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAll${pascalKey}Jobs,
  isCompanyJob: is${pascalKey}Job,
  isTrustedDomain,
  defaultSourceLang: '${sourceLang}',
}).catch((err) => {
  console.error(\`❌ ${companyName} crawler failed: \${err?.message || err}\`);
  process.exit(1);
});
`;

/* ── Template: Workflow ──────────────────────────────────────── */

const workflowContent = `name: Update ${companyName} Jobs (Dedicated)

on:
  workflow_dispatch:
    inputs:
      strict_localization:
        description: 'Fail if any locale is missing/untranslated (1=yes, 0=no)'
        required: false
        default: '1'
        type: string
      timeout_ms:
        description: 'Optional request timeout in ms (4000-15000)'
        required: false
        type: string
      skip_ai_translation:
        description: "Skip AI translation (1=yes, cache only)"
        required: false
        default: "0"
        type: string

concurrency:
  group: jobs-crawler-${companyKey}
  cancel-in-progress: false

permissions:
  contents: write
  issues: write

env:
  NODE_OPTIONS: '--disable-warning=DEP0040 --disable-warning=DEP0169'

jobs:
  update-${companyKey}-jobs:
    runs-on: ubuntu-latest
    timeout-minutes: 360

    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 50

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: '22'
          cache: npm

      - name: Install dependencies
        run: npm ci
${playwrightTier ? `
      - name: Install Playwright Chromium
        run: npx playwright install --with-deps chromium
` : ''}
      - name: Prepare Firebase credentials (optional)
        env:
          FIREBASE_SERVICE_ACCOUNT_JSON: \${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}
        run: |
          if [ -n "$FIREBASE_SERVICE_ACCOUNT_JSON" ]; then
            printf '%s' "$FIREBASE_SERVICE_ACCOUNT_JSON" > /tmp/firebase-sa.json
          else
            echo "ℹ️ Firebase secrets not set — crawler will use file config only."
            exit 0
          fi
          echo "GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-sa.json" >> "$GITHUB_ENV"

      - name: Load secrets from Remote Config
        run: node scripts/load-rc-env.mjs

      - name: Run dedicated ${companyName} crawler
        env:
          JOBS_CRAWLER_TIMEOUT_MS: \${{ github.event.inputs.timeout_ms || '' }}
          JOBS_CRAWLER_USE_FIRESTORE_CONFIG: '1'
          JOBS_${CONST_PREFIX}_STRICT: \${{ github.event.inputs.strict_localization || '1' }}
          CRAWLER_SLICE_ONLY: '1'
          SKIP_AI_TRANSLATION: \${{ github.event.inputs.skip_ai_translation || '0' }}
        run: node scripts/update-${companyKey}-jobs.mjs

      - name: Housekeeping — remove expired job listings (scoped)
        env:
          JOBS_HOUSEKEEPING_SCOPE: '${companyKey}'
          JOBS_SLICE_FILE: 'data/jobs/by-crawler/${companyKey}.json'
        run: node scripts/cleanup-jobs.mjs
        continue-on-error: true

      - name: Commit and push
        id: changes
        env:
          SKIP_AI_TRANSLATION: \${{ github.event.inputs.skip_ai_translation || '0' }}
        run: bash scripts/lib/git-commit-data.sh --slice-only "💼 Auto-update ${companyName} jobs (dedicated crawler)" data/jobs-crawler-adapters/

      - name: Report failure to Linear
        if: failure()
        continue-on-error: true
        run: |
          node scripts/lib/linear-issue-creator.mjs \\
            --title "Crawler Failure: \${{ github.workflow }}" \\
            --description "## Crawler fallito
          **Run:** https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
          **Branch:** \${{ github.ref_name }}
          **Trigger:** \${{ github.event_name }}" \\
            --priority 2 \\
            --label Bug \\
            --workflow "\${{ github.workflow }}"
`;

/* ── Template: Test ──────────────────────────────────────────── */

const testContent = `import { describe, it, expect } from 'vitest';
import {
  ${CONST_PREFIX}_KEY,
  ${CONST_PREFIX}_COMPANY_NAME,
  is${pascalKey}Job,
  isTrustedDomain,
} from '../scripts/lib/${companyKey}-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('${companyName} crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(${CONST_PREFIX}_KEY).toBe('${companyKey}');
    expect(${CONST_PREFIX}_COMPANY_NAME).toBe('${companyName}');
  });

  // ── isCompanyJob ──
  describe('is${pascalKey}Job', () => {
    it('matches by companyKey', () => {
      expect(is${pascalKey}Job({ companyKey: '${companyKey}' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(is${pascalKey}Job({ company: '${companyName}' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(is${pascalKey}Job({ url: 'https://${companyDomain}/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(is${pascalKey}Job({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(is${pascalKey}Job(null)).toBe(false);
      expect(is${pascalKey}Job(undefined)).toBe(false);
      expect(is${pascalKey}Job({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://${companyDomain}/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.${companyDomain}/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer ${companyKey} ch')).toBe('developer-${companyKey}-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: '${companyKey}-abc123',
      slug: 'test-position-${companyKey}-ch',
      slugByLocale: { ${sourceLang}: 'test-position-${companyKey}-ch' },
      company: '${companyName}',
      companyKey: '${companyKey}',
      title: 'Test Position',
      titleByLocale: { ${sourceLang}: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { ${sourceLang}: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://${companyDomain}/jobs/test',
      source: '${companyName} Dedicated Parser',
      sourceLang: '${sourceLang}',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^${companyKey}-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
`;

/* ── Write Files ─────────────────────────────────────────────── */

function writeFile(filePath, content, label) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`  ✅ ${label}: ${path.relative(ROOT, filePath)}`);
}

console.log(`\n🏗️  Scaffolding crawler: ${companyKey} (${companyName}) [--ats=${atsTier}${playwrightTier ? ', --playwright' : ''}]\n`);

writeFile(files.parser, parserContent, 'Parser');
writeFile(files.runner, runnerContent, 'Runner');
writeFile(files.workflow, workflowContent, 'Workflow');
writeFile(files.test, testContent, 'Test');

/* ── Logo registry + local mirror ────────────────────────────── */

function registerLogo(key, domain) {
  const tsPath = path.join(ROOT, 'services', 'jobDataNormalization.ts');
  const src = fs.readFileSync(tsPath, 'utf-8');
  // Skip if the slug is already in the registry. The download script will
  // overwrite the upstream URL with a local path via the manifest overlay.
  const alreadyRegistered = new RegExp(`['"]${key}['"]\\s*:`).test(src);
  if (alreadyRegistered) {
    console.log(`  ✅ Logo registry: '${key}' already present — skipping insert.`);
    return;
  }
  // Insert the new entry alphabetically inside the CRAWLED_COMPANY_LOGOS
  // block. We keep the ordering consistent so audits/diffs stay readable.
  const blockMatch = src.match(/(CRAWLED_COMPANY_LOGOS:\s*Record<string,\s*string>\s*=\s*\{)([\s\S]*?)(\n\};)/);
  if (!blockMatch) {
    console.warn(`  ⚠️  Logo registry: could not locate CRAWLED_COMPANY_LOGOS — add '${key}': cLogo('${domain}') manually.`);
    return;
  }
  const [, header, body, footer] = blockMatch;
  const newEntry = ` '${key}': cLogo('${domain}'),`;
  const lines = body.split('\n');
  // Find the alphabetic insertion point — match how existing entries are
  // keyed (each line starts with ' 'slug':' and is sorted alphabetically).
  let inserted = false;
  const out = [];
  for (const line of lines) {
    if (!inserted) {
      const m = line.match(/^\s*['"]([a-z0-9-]+)['"]\s*:/);
      if (m && m[1].localeCompare(key) > 0) {
        out.push(newEntry);
        inserted = true;
      }
    }
    out.push(line);
  }
  if (!inserted) {
    // Append at the end (right before the closing brace) as a fallback.
    const insertAt = out.length - 1;
    out.splice(insertAt, 0, newEntry);
  }
  const next = src.replace(blockMatch[0], `${header}${out.join('\n')}${footer}`);
  fs.writeFileSync(tsPath, next, 'utf-8');
  console.log(`  ✅ Logo registry: inserted '${key}': cLogo('${domain}') into CRAWLED_COMPANY_LOGOS.`);
}

function mirrorLogo(key, domain) {
  console.log(`\n🖼️  Mirroring logo for ${key} (${domain})...`);
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'download-company-logos.mjs'), '--slug', key, '--domain', domain],
      { stdio: 'inherit', cwd: ROOT },
    );
  } catch (err) {
    console.warn(`  ⚠️  Logo mirror failed (${err?.message || err}). The crawler is still scaffolded; rerun \`node scripts/download-company-logos.mjs --slug ${key} --domain ${domain}\` after fixing the issue.`);
  }
}

registerLogo(companyKey, companyDomain);
mirrorLogo(companyKey, companyDomain);

console.log(`
═══════════════════════════════════════════════════════════════
  ✅ Scaffold complete! Next steps:
═══════════════════════════════════════════════════════════════

  1. IMPLEMENT THE PARSER
     Edit: scripts/lib/${companyKey}-job-parser.mjs
     → Replace fetchJobListings() with actual API/scraping logic
     → Set correct location/canton detection
     → Set appropriate sector

  2. RUN TESTS
     npx vitest run tests/${companyKey}-crawler.test.ts

  3. TEST LOCALLY
     node scripts/update-${companyKey}-jobs.mjs

  4. REGISTER LOCATION
     Add to COMPANY_HQ in scripts/lib/crawler-location-config.mjs:
       '${companyKey}': { city: 'TODO', canton: 'TODO', postalCode: 'TODO', addressRegion: 'TODO' },

     (Logo is already registered + mirrored to public/images/brands/${companyKey}.* —
     verify it in public/logos-audit.html. If wrong, edit CRAWLED_COMPANY_LOGOS in
     services/jobDataNormalization.ts and rerun:
       node scripts/download-company-logos.mjs --slug ${companyKey})

  5. REGISTER IN ORCHESTRATOR
     Add '${companyKey}' to data/jobs-crawler-config.json

  7. PUSH & TRIGGER
     git add -A && git commit -m "feat(crawler): add ${companyName} dedicated crawler"
     git push
     gh workflow run update-jobs-${companyKey}.yml

  8. AFTER CRAWLER SUCCEEDS
     gh workflow run translate-pending.yml
     # Then verify: zero overlaps, all 4 locales populated
`);

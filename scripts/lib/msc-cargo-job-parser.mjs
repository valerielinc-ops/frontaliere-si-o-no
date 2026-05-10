#!/usr/bin/env node
/**
 * MSC Cargo job parser — Adzuna free-tier metadata fallback.
 *
 * Source (anti-bot): https://www.msc.com/en/careers  → Akamai BMP 403
 *                    (akamai-grn header)
 * Fallback:          Adzuna Switzerland (`ch`) free-tier search API
 *
 * Why Adzuna?
 *   - Direct careers URL is behind Akamai Bot Manager Premier and would
 *     require ~$8/mo residential proxy + Playwright stack to bypass.
 *   - Adzuna is itself a job aggregator: each listing's `redirect_url`
 *     is an Adzuna landing that deep-links to MSC's official posting,
 *     so applyUrl pointing at Adzuna is fully ToS-compliant.
 *   - Free tier (1000 calls/mo per app_id) covers daily refreshes for
 *     both Tier-3 anti-bot employers (~30-60 calls/mo combined).
 *
 * Required env: ADZUNA_APP_ID, ADZUNA_APP_KEY (set as GitHub Actions secrets).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMscCargoJobs()   — Fetch via Adzuna and build ParsedJob[]
 *   - isMscCargoJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs (Adzuna domain allowed as fallback)
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { slugify, stripHtml } from './crawler-template.mjs';
import { searchAdzunaAllPages, parseAdzunaJobs } from './adzuna-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MSC_CARGO_KEY = 'msc-cargo';
export const MSC_CARGO_COMPANY_NAME = 'MSC Cargo';
export const MSC_CARGO_COMPANY_DOMAIN = 'msc.com';

const CAREER_URL = 'https://www.msc.com/en/careers';

// MSC trades under several legal entities; match the family broadly but
// reject MSC the cruise line (`MSC Cruises`) which is a separate employer.
const MSC_BRAND_PATTERNS = [
  /\bmsc\s+(mediterranean|cargo|shipping|ag|sa|ch|switzerland|logistics|terminals|technology|air)/i,
  /\bmediterranean shipping company\b/i,
  /\bmsc gva\b/i,
  /^\s*msc\s*$/i, // bare "MSC" employer name
];
const MSC_REJECT_PATTERNS = [
  /\bmsc cruises?\b/i,
  /\bcruise\b/i,
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to MSC Cargo.
 */
export function isMscCargoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MSC_CARGO_KEY ||
    key.startsWith('msc-cargo') ||
    company.includes('msc cargo') ||
    url.includes('msc.com')
  );
}

/**
 * Validate that a URL belongs to a trusted MSC surface OR Adzuna
 * (since the Adzuna fallback emits applyUrl pointing at adzuna.com/...).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'msc.com' ||
      host.endsWith('.msc.com') ||
      host === 'adzuna.com' ||
      host.endsWith('.adzuna.com') ||
      host === 'adzuna.ch' ||
      host.endsWith('.adzuna.ch')
    );
  } catch {
    return false;
  }
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

function mscMatcher(displayName = '') {
  if (!displayName) return false;
  if (MSC_REJECT_PATTERNS.some((rx) => rx.test(displayName))) return false;
  return MSC_BRAND_PATTERNS.some((rx) => rx.test(displayName));
}

/**
 * Fetch all MSC Cargo jobs via the Adzuna free-tier API.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Test/dev hook: `opts._fetchImpl` and `opts._cacheDate` are forwarded to
 * `searchAdzunaAllPages` so suites never hit the live Adzuna API.
 */
export async function fetchAllMscCargoJobs(opts = {}) {
  console.log(`🔍 Fetching MSC Cargo jobs via Adzuna fallback`);
  console.log(`   Direct careers URL (blocked by Akamai BMP): ${CAREER_URL}`);
  console.log(`   Adzuna country: ch — MSC family brand match (excluding MSC Cruises)\n`);

  const employer = {
    key: MSC_CARGO_KEY,
    name: MSC_CARGO_COMPANY_NAME,
    domain: MSC_CARGO_COMPANY_DOMAIN,
    match: mscMatcher,
    sector: 'Logistica',
    defaultLocation: 'Geneva',
    defaultCanton: 'GE',
    parserSourceLabel: 'MSC Cargo Adzuna Fallback',
  };

  const { results, liveCalls } = await searchAdzunaAllPages({
    company: 'MSC',
    country: 'ch',
    ...opts,
  });

  console.log(`  📋 Adzuna listings raw: ${results.length} (live API calls: ${liveCalls})`);

  const jobs = parseAdzunaJobs({ results }, employer);
  console.log(`\n📋 Total MSC Cargo jobs (post-filter): ${jobs.length}`);
  return jobs;
}

// Re-export shared utilities so callers can pull everything from one module.
export { slugify, stripHtml };

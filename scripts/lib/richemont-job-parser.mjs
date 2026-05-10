#!/usr/bin/env node
/**
 * Richemont job parser — Adzuna free-tier metadata fallback.
 *
 * Source (anti-bot): https://careers.richemont.com/en/jobs/  → Cloudflare 403
 * Fallback:          Adzuna Switzerland (`ch`) free-tier search API
 *
 * Why Adzuna?
 *   - Direct careers URL is behind Cloudflare (`cf-ray` header) and would
 *     require ~$8/mo residential proxy + Playwright stack to bypass.
 *   - Adzuna is itself a job aggregator: each listing's `redirect_url`
 *     is an Adzuna landing that deep-links to Richemont's official posting,
 *     so applyUrl pointing at Adzuna is fully ToS-compliant.
 *   - Free tier (1000 calls/mo per app_id) covers daily refreshes for
 *     both Tier-3 anti-bot employers (~30-60 calls/mo combined).
 *
 * Required env: ADZUNA_APP_ID, ADZUNA_APP_KEY (set as GitHub Actions secrets).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRichemontJobs()  — Fetch via Adzuna and build ParsedJob[]
 *   - isRichemontJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs (Adzuna domain allowed as fallback)
 *   - slugify() / stripHtml()  — Re-exported from crawler-template.mjs
 */
import { slugify, stripHtml } from './crawler-template.mjs';
import { searchAdzunaAllPages, parseAdzunaJobs } from './adzuna-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RICHEMONT_KEY = 'richemont';
export const RICHEMONT_COMPANY_NAME = 'Richemont';
export const RICHEMONT_COMPANY_DOMAIN = 'richemont.com';

const CAREER_URL = 'https://careers.richemont.com/en/jobs/';

// Brands inside Richemont group — Adzuna free-text search returns listings
// where the company display_name is the maison, not the holding. Match all
// known maisons so the fallback captures the full Richemont footprint.
const RICHEMONT_BRAND_PATTERNS = [
  /richemont/i,
  /cartier/i,
  /\bvan cleef\b/i,
  /\biwc\b/i,
  /jaeger.?lecoultre/i,
  /piaget/i,
  /vacheron constantin/i,
  /panerai/i,
  /\bmontblanc\b/i,
  /baume.?\&?.?mercier/i,
  /\ba\.?\s*lange\s*&?\s*söhne\b/i,
  /\bdunhill\b/i,
  /\bchloé\b|\bchloe\b/i,
  /\balaïa\b|\balaia\b/i,
  /\bnet.?a.?porter\b/i,
  /\bmr\s*porter\b/i,
  /\byoox\b/i,
  /watchfinder/i,
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Richemont (incl. its maisons).
 */
export function isRichemontJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RICHEMONT_KEY ||
    key.startsWith('richemont') ||
    company.includes('richemont') ||
    url.includes('richemont.com')
  );
}

/**
 * Validate that a URL belongs to a trusted Richemont surface OR Adzuna
 * (since the Adzuna fallback emits applyUrl pointing at adzuna.com/...).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'richemont.com' ||
      host.endsWith('.richemont.com') ||
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

function richemontMatcher(displayName = '') {
  return RICHEMONT_BRAND_PATTERNS.some((rx) => rx.test(displayName));
}

/**
 * Fetch all Richemont jobs via the Adzuna free-tier API.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Test/dev hook: `opts._fetchImpl` and `opts._cacheDate` are forwarded to
 * `searchAdzunaAllPages` so suites never hit the live Adzuna API.
 */
export async function fetchAllRichemontJobs(opts = {}) {
  console.log(`🔍 Fetching Richemont jobs via Adzuna fallback`);
  console.log(`   Direct careers URL (blocked by Cloudflare): ${CAREER_URL}`);
  console.log(`   Adzuna country: ch — brand match across ${RICHEMONT_BRAND_PATTERNS.length} maisons\n`);

  const employer = {
    key: RICHEMONT_KEY,
    name: RICHEMONT_COMPANY_NAME,
    domain: RICHEMONT_COMPANY_DOMAIN,
    match: richemontMatcher,
    sector: 'Lusso',
    defaultLocation: 'Bellevue',
    defaultCanton: 'GE',
    parserSourceLabel: 'Richemont Adzuna Fallback',
  };

  const { results, liveCalls } = await searchAdzunaAllPages({
    company: 'Richemont',
    country: 'ch',
    ...opts,
  });

  console.log(`  📋 Adzuna listings raw: ${results.length} (live API calls: ${liveCalls})`);

  const jobs = parseAdzunaJobs({ results }, employer);
  console.log(`\n📋 Total Richemont jobs (post-filter): ${jobs.length}`);
  return jobs;
}

// Re-export shared utilities so callers can pull everything from one module.
export { slugify, stripHtml };

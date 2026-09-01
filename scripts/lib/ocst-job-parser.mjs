#!/usr/bin/env node
/**
 * OCST careers parser — authoritative source-state reader.
 *
 * Source: https://www.ocst.ch/il-sindacato/lavora-con-noi
 *
 * Exports the functions required by the crawler template:
 *   - fetchAllOcstJobs()  — Fetch and parse the authoritative careers page
 *   - assertCompleteOcstSnapshot() — Prove an explicit empty source state
 *   - isOcstJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to this company
 */
import { JSDOM } from 'jsdom';
import { politeFetch } from './prospector/polite-fetch.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OCST_KEY = 'ocst';
export const OCST_COMPANY_NAME = 'OCST';
export const OCST_COMPANY_DOMAIN = 'ocst.ch';

export const OCST_CAREER_URL = 'https://www.ocst.ch/il-sindacato/lavora-con-noi';
const EXPLICIT_EMPTY_RE = /\b(?:attualmente\s+)?non\s+(?:ci\s+)?sono\s+posizioni\s+aperte\b/i;
const OCST_REQUEST_HEADERS = {
  // The public-DNS dispatcher exposes OCST's gzip bytes without decoding them.
  // Identity encoding preserves the SSRF-safe transport and yields parseable HTML.
  'Accept-Encoding': 'identity',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to OCST.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isOcstJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === OCST_KEY ||
    key.startsWith('ocst') ||
    company.includes('ocst') ||
    url.includes('ocst.ch')
  );
}

/**
 * Validate that a URL belongs to OCST's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ocst.ch' || host.endsWith('.ocst.ch');
  } catch {
    return false;
  }
}

/* ── Authoritative source boundary ─────────────────────────── */

/**
 * Read only the semantic body of OCST's careers article. The rest of the page
 * contains general news links which the old learned template mistook for job
 * details. An explicit "no positions" sentence inside this exact boundary is
 * authoritative; missing or unfamiliar markup throws so the pipeline keeps
 * the previous slice instead of publishing guessed vacancies or a guessed 0.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {[]}
 */
export function extractOcstCareersSnapshot(html = '', pageUrl = OCST_CAREER_URL) {
  let effectiveUrl;
  try {
    effectiveUrl = new URL(pageUrl);
  } catch {
    throw new Error(`OCST careers source returned an invalid URL: ${pageUrl}`);
  }
  const expectedUrl = new URL(OCST_CAREER_URL);
  if (
    effectiveUrl.protocol !== expectedUrl.protocol
    || effectiveUrl.hostname !== expectedUrl.hostname
    || effectiveUrl.pathname.replace(/\/+$/, '') !== expectedUrl.pathname
  ) {
    throw new Error(`OCST careers source drifted outside the expected page: ${effectiveUrl.href}`);
  }

  const dom = new JSDOM(html);
  try {
    const bodies = dom.window.document.querySelectorAll('#t3-content article section.article-content');
    if (bodies.length !== 1) {
      throw new Error(`OCST careers article boundary missing or ambiguous (${bodies.length} matches)`);
    }
    const body = bodies[0].cloneNode(true);
    for (const node of body.querySelectorAll('form, script, style, noscript')) node.remove();
    const text = String(body.textContent || '').replace(/\s+/g, ' ').trim();
    if (!EXPLICIT_EMPTY_RE.test(text)) {
      throw new Error('OCST careers page has no supported vacancy list or explicit empty-state marker');
    }
    return [];
  } finally {
    dom.window.close();
  }
}

/**
 * Mark the source-proven state without serialising crawler-control metadata
 * into the dataset payload.
 *
 * @param {object[]} jobs
 * @returns {object[]}
 */
function markExplicitEmptySnapshot(jobs) {
  Object.defineProperty(jobs, 'ocstSnapshotState', {
    value: 'explicit-empty',
    enumerable: false,
  });
  Object.defineProperty(jobs, 'discoveredCount', {
    value: 0,
    enumerable: false,
  });
  return jobs;
}

/**
 * Source-specific completeness proof consumed by the standard pipeline.
 * Plain empty arrays are deliberately rejected.
 *
 * @param {object[]} jobs
 * @returns {true}
 */
export function assertCompleteOcstSnapshot(jobs) {
  if (!Array.isArray(jobs) || jobs.length !== 0 || Reflect.get(jobs, 'ocstSnapshotState') !== 'explicit-empty') {
    throw new Error('OCST snapshot is not an explicit authoritative empty state');
  }
  return true;
}

/**
 * Fetch all OCST jobs.
 * OCST currently publishes no vacancies and exposes a single authoritative
 * empty-state page. `fetchPage` is injectable for deterministic tests.
 *
 * `ignoreRobots` is intentionally narrow to this request: OCST's robots URL
 * currently redirects HTTPS to the malformed origin `http://www.ocst.ch`,
 * while the requested HTTPS careers page itself is healthy. `politeFetch`
 * still enforces the identifying UA, host throttling, public-DNS policy and
 * same-host redirect validation for the careers page.
 *
 * @param {{ fetchPage?: typeof politeFetch }} [runtime]
 */
export async function fetchAllOcstJobs({ fetchPage = politeFetch } = {}) {
  console.log(`🔍 Fetching OCST jobs`);
  console.log(`   Source: ${OCST_CAREER_URL}\n`);

  const page = await fetchPage(OCST_CAREER_URL, {
    ignoreRobots: true,
    headers: OCST_REQUEST_HEADERS,
  });
  if (!page?.ok) {
    const reason = page?.policyBlocked
      ? (page.error || 'public URL policy rejected the request')
      : `HTTP ${page?.status || 0}`;
    const error = Object.assign(
      new Error(`OCST careers fetch failed for ${page?.url || OCST_CAREER_URL}: ${reason}`),
      { status: page?.status || undefined },
    );
    throw error;
  }

  const jobs = extractOcstCareersSnapshot(page.body, page.url || OCST_CAREER_URL);
  console.log('  ✅ OCST explicitly reports no open positions.');
  return markExplicitEmptySnapshot(jobs);
}

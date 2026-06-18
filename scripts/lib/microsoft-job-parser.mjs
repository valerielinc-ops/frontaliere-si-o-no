#!/usr/bin/env node
/**
 * Microsoft job parser — Fetcher and job builder.
 *
 * Source: https://apply.careers.microsoft.com/careers?domain=microsoft.com
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMicrosoftJobs()  — Fetch and parse all jobs
 *   - isMicrosoftJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { normalizeCantonCode, canonicalSwissCityName } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MICROSOFT_KEY = 'microsoft';
export const MICROSOFT_COMPANY_NAME = 'Microsoft';
export const MICROSOFT_COMPANY_DOMAIN = 'microsoft.com';

const CAREER_URL = 'https://apply.careers.microsoft.com/careers?domain=microsoft.com';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Microsoft.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMicrosoftJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MICROSOFT_KEY ||
    key.startsWith('microsoft') ||
    company.includes('microsoft') ||
    url.includes('microsoft.com')
  );
}

/**
 * Validate that a URL belongs to Microsoft's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'microsoft.com' || host.endsWith('.microsoft.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Eightfold PCS API ─────────────────────────────────────── */
//
// Microsoft Careers runs on Eightfold's Personalized Career Site (PCS).
// The public jobs API lives under `/api/pcsx/*` and is CSRF-gated: the
// careers HTML page returns a fresh `x-csrf-token` response header (plus
// session cookies) that every `/api/pcsx/*` call must echo back. Without it
// the API answers `403 {"message": "Not authorized for PCSX"}`.
//
//   1. search          → paginated job list (10 per page, `num` is capped)
//   2. position_details → full HTML job description for one position
//
// `filter_include_remote=1` matches the source URL but also pulls in
// remote-eligible non-CH roles, so results are filtered to postings whose
// `standardizedLocations[]` contain a Switzerland (`…, CH`) entry.

const PCS_ORIGIN = 'https://apply.careers.microsoft.com';
const PCS_DOMAIN = 'microsoft.com';
const PCS_PAGE_SIZE = 10; // Eightfold caps `num` at 10 regardless of request
const PCS_MAX_PAGES_PER_ANCHOR = 8; // safety cap (≤80 listings scanned/anchor)
const PCS_REQ_DELAY_MS = 350;

// Distance-radius anchors. The country-level "Switzerland" query already
// returns the full CH set, but the geocoded radius occasionally misses a hub
// (observed: a Geneva-specific query returning 0 while the city has jobs), so
// the main Swiss hubs are probed too and results are merged + de-duplicated.
const PCS_SEARCH_ANCHORS = [
  'Switzerland',
  'Zurich, Switzerland',
  'Geneva, Switzerland',
  'Basel, Switzerland',
  'Bern, Switzerland',
  'Lausanne, Switzerland',
  'Lugano, Switzerland',
];

const PCS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bootstrap an Eightfold PCS session by loading the careers page and reading
 * the `x-csrf-token` response header + any session cookies it sets.
 *
 * @returns {Promise<{ csrf: string, cookie: string }>}
 */
async function bootstrapPcsSession() {
  const res = await fetch(`${PCS_ORIGIN}/careers?domain=${PCS_DOMAIN}`, {
    headers: { 'User-Agent': PCS_USER_AGENT, Accept: 'text/html' },
  });
  const csrf = res.headers.get('x-csrf-token') || '';
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  await res.text().catch(() => {}); // drain body, release the socket
  if (!csrf) throw new Error('Eightfold PCS: could not obtain CSRF token');
  return { csrf, cookie };
}

/** Build the request headers an `/api/pcsx/*` call needs. */
function pcsHeaders(session) {
  const headers = {
    'User-Agent': PCS_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'x-csrf-token': session.csrf,
    Referer: `${PCS_ORIGIN}/careers`,
  };
  if (session.cookie) headers.Cookie = session.cookie;
  return headers;
}

/**
 * GET a PCS JSON endpoint, refreshing the (short-lived) CSRF token once on a
 * 401/403 before giving up.
 *
 * @param {string} url
 * @param {{ csrf: string, cookie: string }} session Mutated in place on refresh.
 * @returns {Promise<any>}
 */
async function pcsGetJson(url, session) {
  let res = await fetch(url, { headers: pcsHeaders(session) });
  if (res.status === 401 || res.status === 403) {
    const fresh = await bootstrapPcsSession();
    session.csrf = fresh.csrf;
    session.cookie = fresh.cookie;
    res = await fetch(url, { headers: pcsHeaders(session) });
  }
  if (!res.ok) throw new Error(`Eightfold PCS: HTTP ${res.status} for ${url}`);
  return res.json();
}

/** True when an Eightfold `standardizedLocations[]` entry is in Switzerland. */
function isSwissStdLocation(entry = '') {
  const parts = String(entry)
    .split(',')
    .map((s) => s.trim());
  return (parts[parts.length - 1] || '').toUpperCase() === 'CH';
}

/**
 * Resolve `{ location, canton }` for a position. Prefers a specific Swiss city
 * (e.g. `"Zürich, ZH, CH"` → `Zürich` / `ZH`); falls back to a nationwide tag
 * (`location: 'Switzerland'`, empty canton) for country-only or multi-country
 * postings so they land on the `/cerca-lavoro-svizzera/` aggregator rather than
 * being mis-assigned to a single canton.
 *
 * @param {object} position
 * @returns {{ location: string, canton: string }}
 */
function resolveSwissLocation(position) {
  const std = Array.isArray(position?.standardizedLocations)
    ? position.standardizedLocations
    : [];
  for (const entry of std) {
    const parts = String(entry)
      .split(',')
      .map((s) => s.trim());
    if ((parts[parts.length - 1] || '').toUpperCase() !== 'CH') continue;
    if (parts.length >= 3) {
      const canton = normalizeCantonCode(parts[1]);
      const city = canonicalSwissCityName(parts[0]);
      if (canton && city) return { location: city, canton };
    }
  }
  // Country-only ("CH") or multi-country posting → nationwide.
  return { location: 'Switzerland', canton: '' };
}

/**
 * Fetch all Switzerland-based Microsoft positions across the search anchors,
 * de-duplicated by position id, then enrich each with its full job description.
 *
 * @returns {Promise<object[]>} Raw Eightfold positions (search + detail merged).
 */
async function fetchSwissPositions() {
  const session = await bootstrapPcsSession();
  const byId = new Map();

  for (const anchor of PCS_SEARCH_ANCHORS) {
    let total = Infinity;
    for (let page = 0; page < PCS_MAX_PAGES_PER_ANCHOR; page += 1) {
      const start = page * PCS_PAGE_SIZE;
      if (start >= total) break;
      const url =
        `${PCS_ORIGIN}/api/pcsx/search?domain=${PCS_DOMAIN}&query=` +
        `&location=${encodeURIComponent(anchor)}` +
        `&start=${start}&sort_by=distance&filter_include_remote=1`;
      let payload;
      try {
        payload = await pcsGetJson(url, session);
      } catch (err) {
        console.warn(`   ⚠️  search "${anchor}" page ${page} failed: ${err?.message || err}`);
        break;
      }
      const data = payload?.data || {};
      if (Number.isFinite(data.count)) total = data.count;
      const positions = Array.isArray(data.positions) ? data.positions : [];
      if (positions.length === 0) break;
      for (const pos of positions) {
        const id = String(pos?.id || pos?.atsJobId || '');
        if (!id || byId.has(id)) continue;
        const std = Array.isArray(pos?.standardizedLocations) ? pos.standardizedLocations : [];
        if (!std.some(isSwissStdLocation)) continue; // drop remote non-CH roles
        byId.set(id, pos);
      }
      await sleep(PCS_REQ_DELAY_MS);
    }
  }

  const positions = [...byId.values()];
  console.log(`  📋 Switzerland positions found: ${positions.length}`);

  // Enrich with full job descriptions (the search payload omits them).
  const detailed = [];
  for (const pos of positions) {
    const id = String(pos.id);
    const url =
      `${PCS_ORIGIN}/api/pcsx/position_details?position_id=${encodeURIComponent(id)}` +
      `&domain=${PCS_DOMAIN}&hl=en`;
    let detail = null;
    try {
      const payload = await pcsGetJson(url, session);
      detail = payload?.data || null;
    } catch (err) {
      console.warn(`   ⚠️  position_details ${id} failed: ${err?.message || err}`);
    }
    detailed.push({ ...pos, ...(detail || {}) });
    await sleep(PCS_REQ_DELAY_MS);
  }
  return detailed;
}

/**
 * Fetch all Microsoft (Switzerland) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMicrosoftJobs() {
  console.log(`🔍 Fetching Microsoft jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let positions = [];
  try {
    positions = await fetchSwissPositions();
  } catch (err) {
    console.error(`❌ Eightfold PCS fetch failed: ${err?.message || err}`);
    return [];
  }
  if (positions.length === 0) {
    console.warn('⚠️ No Switzerland job listings returned.');
    return [];
  }

  const jobs = [];
  for (const pos of positions) {
    const title = normalizeSpace(pos.name || '');
    if (!title || title.length < 3) continue;

    const displayJobId = String(pos.displayJobId || pos.atsJobId || pos.id || '').trim();
    const { location, canton } = resolveSwissLocation(pos);
    const descriptionHtml = pos.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = pos.publicUrl || `${PCS_ORIGIN}/careers/job/${pos.id}`;
    const department = normalizeSpace(pos.department || '');
    const employmentRaw = Array.isArray(pos.efcustomTextEmploymentType)
      ? pos.efcustomTextEmploymentType.join(' ')
      : String(pos.efcustomTextEmploymentType || '');

    const sourceLang = detectLang(descriptionText || title, 'en');
    const slugCity = location && location !== 'Switzerland' ? location : 'switzerland';
    const jobSlug = slugify(`${title} microsoft ${slugCity}`);

    const postedTs = Number(pos.postedTs || pos.creationTs || 0);
    const postedDate =
      postedTs > 0
        ? new Date(postedTs * 1000).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `microsoft-${slugify(displayJobId) || pos.id}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MICROSOFT_COMPANY_NAME,
      companyKey: MICROSOFT_KEY,
      companyDomain: MICROSOFT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Microsoft`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Microsoft` },
      location,
      canton,
      url: publicUrl,
      source: 'Microsoft Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(`${title} ${department}`),
      contract: /part.?time/i.test(employmentRaw) ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(employmentRaw || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Microsoft jobs discovered: ${jobs.length}`);
  return jobs;
}

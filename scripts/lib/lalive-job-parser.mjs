#!/usr/bin/env node
/**
 * LALIVE job parser — Fetcher and job builder (Personio ATS).
 *
 * Source:
 * - Career site: https://lalive-law.jobs.personio.com
 * - JSON feed:   https://lalive-law.jobs.personio.com/search.json?language=en
 * - Detail:      https://lalive-law.jobs.personio.com/job/{id}
 *
 * LALIVE is an international arbitration & dispute resolution law firm
 * headquartered in Geneva, with offices in Zurich and London. Its Personio
 * tenant lists openings for all three offices; we keep jobs whose office(s)
 * include Geneva (GVA) and/or Zurich (ZRH) — the Swiss target locations —
 * and use the first Swiss office listed as the job's primary location.
 *
 * Personio ships an unauthenticated `/search.json` endpoint that returns
 * the same payload the careers SPA hydrates from. Each record carries a
 * full HTML `description`, `employment_type`, `schedule`, `office`(s) and
 * `department`. We synthesise the canonical detail URL as `/job/{id}`
 * (Personio resolves the per-locale slug from there).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLaliveJobs()  — Fetch and parse all jobs
 *   - isLaliveJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LALIVE_KEY = 'lalive';
export const LALIVE_COMPANY_NAME = 'LALIVE';
export const LALIVE_COMPANY_DOMAIN = 'lalive.law';

const PERSONIO_API_URL = 'https://lalive-law.jobs.personio.com/search.json?language=en';
const CAREER_URL = 'https://lalive-law.jobs.personio.com';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// Personio office labels → { city, canton, postalCode }. Only Swiss offices
// are kept as valid job locations (the tenant also lists London (LON)).
const OFFICE_LOCATIONS = {
  'geneva (gva)': { city: 'Ginevra', canton: 'GE', postalCode: '1204' },
  'zurich (zrh)': { city: 'Zurigo', canton: 'ZH', postalCode: '8001' },
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Pick the first Swiss office (Geneva or Zurich) from a Personio `office` /
 * `offices` field, which may be a single label or a comma-separated list
 * (e.g. "Geneva (GVA),Zurich (ZRH)").
 */
function resolvePrimarySwissOffice(rec) {
  const rawOffices = Array.isArray(rec?.offices) && rec.offices.length
    ? rec.offices
    : String(rec?.office || '').split(',');

  for (const raw of rawOffices) {
    const key = normalize(raw);
    if (OFFICE_LOCATIONS[key]) return OFFICE_LOCATIONS[key];
  }
  return null;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to LALIVE.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLaliveJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LALIVE_KEY ||
    key.startsWith('lalive') ||
    company.includes('lalive') ||
    url.includes('lalive.law') ||
    url.includes('lalive-law.jobs.personio.com')
  );
}

/**
 * Validate that a URL belongs to LALIVE's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'lalive.law' || host.endsWith('.lalive.law')) return true;
    if (host === 'lalive-law.jobs.personio.com') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

// NB: word-boundary on BOTH ends of "interns?" is required — otherwise it
// false-matches inside "international" (e.g. "INTERNATIONAL ARBITRATION
// ASSOCIATE"), mis-tagging senior-associate roles as internships. Plural
// forms ("trainees", "stagiaires") need an explicit `s?` since a bare
// trailing \b does not match before a trailing "s".
function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(stagiaires?|stagiair|trainees?|praktik\w*|interns?)\b/.test(t)) return 'Formazione';
  if (/\b(support staff|admin|segret|assistant)\b/.test(t)) return 'Amministrazione';
  if (/\b(avocat|lawyer|associate|substitut|arbitration)\b/.test(t)) return 'Legale';
  return 'Legale';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stagiaires?|stagiair|trainees?|praktik\w*|interns?|substitut)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)\b/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

function buildDetailUrl(id) {
  return `${CAREER_URL}/job/${id}`;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchJson(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,*/*' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildParsedJob(rec) {
  const title = normalizeSpace(rec?.name || '');
  if (!title || title.length < 3) return null;

  const loc = resolvePrimarySwissOffice(rec);
  if (!loc) return null; // Skip London-only (or otherwise non-Swiss) postings.

  const descriptionHtml = rec?.description || '';
  const descriptionText = stripHtml(descriptionHtml);
  const publicUrl = buildDetailUrl(rec?.id);
  const sourceLang = detectLang(descriptionText || title, 'fr');
  const jobSlug = slugify(`${title} lalive ${loc.city}`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

  const fallbackDesc = `${title} — Offerta di lavoro presso LALIVE a ${loc.city} (${loc.canton}), Svizzera. `
    + 'LALIVE è uno studio legale internazionale specializzato in arbitrato internazionale '
    + 'e risoluzione di controversie, con uffici a Ginevra, Zurigo e Londra.';
  const desc = descriptionText.length >= 80 ? descriptionText : fallbackDesc;

  const employmentBasis = `${rec?.schedule || ''} ${rec?.employment_type || ''}`;

  return {
    // ── Required fields ──
    id: `lalive-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: LALIVE_COMPANY_NAME,
    companyKey: LALIVE_KEY,
    companyDomain: LALIVE_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: desc,
    descriptionByLocale: { [sourceLang]: desc },
    location: loc.city,
    canton: loc.canton,
    url: publicUrl,
    source: 'LALIVE Dedicated Parser (Personio JSON)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: loc.city,
    addressRegion: loc.canton,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: loc.postalCode,
    category: detectCategory(title),
    contract: detectEmploymentType(employmentBasis) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(employmentBasis),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Legale',
    currency: 'CHF',
    featured: false,
    postedDate: new Date().toISOString().split('T')[0],
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

/**
 * Fetch all LALIVE jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLaliveJobs() {
  console.log(`🔍 Fetching LALIVE jobs (Personio)`);
  console.log(`   Career: ${CAREER_URL}`);
  console.log(`   API:    ${PERSONIO_API_URL}\n`);

  let records = [];
  try {
    records = await fetchJson(PERSONIO_API_URL);
  } catch (err) {
    console.warn(`⚠️ Personio search.json fetch failed: ${err?.message || err}`);
    return [];
  }
  if (!Array.isArray(records)) {
    console.warn(`⚠️ Personio search.json: expected array, got ${typeof records}`);
    return [];
  }
  console.log(`   Total tenant openings: ${records.length}`);

  const jobs = [];
  for (const rec of records) {
    try {
      const job = buildParsedJob(rec);
      if (job) jobs.push(job);
    } catch (err) {
      console.warn(`⚠️ Skipping id=${rec?.id || '<?>'}: ${err?.message || err}`);
    }
  }

  console.log(`\n📋 Total LALIVE jobs discovered: ${jobs.length}`);
  return jobs;
}

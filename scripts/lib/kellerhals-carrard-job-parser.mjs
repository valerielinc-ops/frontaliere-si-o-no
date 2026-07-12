#!/usr/bin/env node
/**
 * Kellerhals Carrard job parser — Personio ATS.
 *
 * Source:
 *   - Career site: https://kellerhals-carrard.jobs.personio.com
 *   - JSON feed:   https://kellerhals-carrard.jobs.personio.com/search.json?language=de
 *   - Detail:      https://kellerhals-carrard.jobs.personio.com/job/{id}
 *
 * Kellerhals Carrard is a national Swiss law firm ("Wirtschaftskanzlei")
 * with offices in Bern, Zürich, Basel and Genève. All postings flow
 * through a single Personio tenant covering every office — unlike
 * single-site Personio tenants (e.g. Fachspital Sune-Egge) we do NOT
 * filter by office; instead we derive location/canton per-job from the
 * `office` field (which may be a comma-separated list, e.g. "Zürich,Basel"
 * for roles open across multiple locations — we take the first as primary).
 *
 * Personio ships an unauthenticated `/search.json` endpoint that returns
 * the same payload the careers SPA hydrates from. Each job carries a full
 * HTML `description`, `employment_type`, `schedule`, `office`, `department`.
 * We synthesise the canonical detail URL as `/job/{id}` (Personio resolves
 * this to the per-locale slug).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKellerhalsCarrardJobs()  — Fetch and parse all jobs
 *   - isKellerhalsCarrardJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KELLERHALS_CARRARD_KEY = 'kellerhals-carrard';
export const KELLERHALS_CARRARD_COMPANY_NAME = 'Kellerhals Carrard';
export const KELLERHALS_CARRARD_COMPANY_DOMAIN = 'kellerhals-carrard.ch';

const CAREER_URL = 'https://kellerhals-carrard.jobs.personio.com';
const PERSONIO_API_URL = 'https://kellerhals-carrard.jobs.personio.com/search.json?language=de';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// Kellerhals Carrard's Personio `office` field is a single value or a
// comma-separated list of offices (e.g. "Zürich,Basel"). We resolve the
// FIRST office in the list as the job's primary location.
const OFFICE_INFO = {
  Basel: { city: 'Basel', canton: 'BS', postalCode: '4051' },
  Binningen: { city: 'Binningen', canton: 'BL', postalCode: '4102' },
  Bern: { city: 'Bern', canton: 'BE', postalCode: '3011' },
  Zürich: { city: 'Zürich', canton: 'ZH', postalCode: '8001' },
  Genève: { city: 'Genève', canton: 'GE', postalCode: '1204' },
};
const DEFAULT_OFFICE = OFFICE_INFO.Bern;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function resolveOffice(rawOffice = '') {
  const first = String(rawOffice || '').split(',')[0].trim();
  return OFFICE_INFO[first] || DEFAULT_OFFICE;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kellerhals Carrard.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKellerhalsCarrardJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KELLERHALS_CARRARD_KEY ||
    key.startsWith('kellerhals-carrard') ||
    company.includes('kellerhals carrard') ||
    url.includes('kellerhals-carrard.ch') ||
    url.includes('kellerhals-carrard.jobs.personio.com')
  );
}

/**
 * Validate that a URL belongs to Kellerhals Carrard's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'kellerhals-carrard.jobs.personio.com') return true;
    if (host === 'kellerhals-carrard.ch' || host.endsWith('.kellerhals-carrard.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory() {
  // Kellerhals Carrard is a law firm ("Wirtschaftskanzlei") — every role
  // (lawyers, trainees, paralegals, business services) sits in Legale.
  return 'Legale';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|volontariat|stagiair|intern|auszubildende|lehrling|lernend|apprenti|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|partner)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*\d{2,3}\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const pct = Number(pctMatch[1]);
    if (pct >= 90) return 'FULL_TIME';
    if (pct > 0) return 'PART_TIME';
  }
  if (/\b(praktikum|volontariat|intern|auszubildende|lehrling|lernend)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|festanstellung)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
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
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildParsedJob(rec) {
  const title = normalizeSpace(rec.name || '');
  if (!title || title.length < 3) return null;

  const office = resolveOffice(rec.office || '');
  const descHtml = String(rec.description || '');
  const descText = stripHtml(descHtml);
  const sourceLang = detectLang(descText || title, 'de');

  const publicUrl = `https://kellerhals-carrard.jobs.personio.com/job/${rec.id}`;
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const jobSlug = slugify(`${title} kellerhals-carrard ${office.city}`);

  const fallbackDesc =
    `${title} — Stelle bei Kellerhals Carrard in ${office.city} (${office.canton}), Schweiz. ` +
    'Kellerhals Carrard ist eine der führenden Schweizer Wirtschaftskanzleien mit Standorten in ' +
    'Bern, Zürich, Basel und Genf.';
  const desc = descText.length >= 80 ? descText : fallbackDesc;

  const postedDate = new Date().toISOString().slice(0, 10);
  const employmentBasis = `${title} ${rec.schedule || ''} ${rec.employment_type || ''}`;

  return {
    id: `kellerhals-carrard-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: KELLERHALS_CARRARD_COMPANY_NAME,
    companyKey: KELLERHALS_CARRARD_KEY,
    companyDomain: KELLERHALS_CARRARD_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: desc,
    descriptionByLocale: { [sourceLang]: desc },
    location: office.city,
    canton: office.canton,
    url: publicUrl,
    source: 'Kellerhals Carrard Dedicated Parser (Personio JSON)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: office.city,
    addressRegion: office.canton,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: office.postalCode,
    category: detectCategory(),
    contract: detectEmploymentType(employmentBasis) === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType: detectEmploymentType(employmentBasis),
    experienceLevel: detectExperienceLevel(title),
    sector: 'Legale',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl: publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    needsRetranslation: true,
  };
}

/**
 * Fetch all Kellerhals Carrard jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllKellerhalsCarrardJobs() {
  console.log(`🔍 Fetching Kellerhals Carrard jobs (Personio)`);
  console.log(`   Career:  ${CAREER_URL}`);
  console.log(`   API:     ${PERSONIO_API_URL}\n`);

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

  console.log(`\n📋 Total Kellerhals Carrard jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Tether Operations job parser — Recruitee API parser.
 *
 * API endpoint: https://tether.recruitee.com/api/offers
 * Careers page: https://tether.recruitee.com/planb
 *
 * Tether is registered in Lugano, TI but all positions are remote.
 * We include ALL offers (no Swiss location filtering) per user request.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllTetherJobs()  — Fetch and parse all jobs
 *   - isTetherJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const TETHER_KEY = 'tether';
export const TETHER_COMPANY_NAME = 'Tether Operations';
export const TETHER_COMPANY_DOMAIN = 'tether.io';

const API_URL = 'https://tether.recruitee.com/api/offers';
const DETAIL_URL_BASE = 'https://tether.recruitee.com/o';
const HQ = getCompanyDefaults(TETHER_KEY);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Tether Operations.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isTetherJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === TETHER_KEY ||
    key.startsWith('tether') ||
    company.includes('tether operations') ||
    url.includes('tether.io')
  );
}

/**
 * Validate that a URL belongs to Tether Operations's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'tether.io' || host.endsWith('.tether.io') || host.endsWith('.recruitee.com');
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

/* ── Recruitee Helpers ─────────────────────────────────────── */

/** Map Recruitee employment_type_code to standard values. */
const EMPLOYMENT_TYPE_MAP = {
  fulltime_permanent: 'FULL_TIME',
  fulltime_fixed_term: 'FULL_TIME',
  parttime: 'PART_TIME',
  internship: 'INTERNSHIP',
  freelance: 'FREELANCE',
};

/**
 * Combine all HTML description sections from a Recruitee offer into one string.
 * Fields: description, requirements, education, experience.
 */
function combineDescriptionSections(offer = {}) {
  const parts = [];
  const fields = ['description', 'requirements', 'education', 'experience'];
  for (const field of fields) {
    const html = String(offer[field] || '').trim();
    if (html) parts.push(html);
  }
  return parts.join('\n');
}

/** Generic/placeholder offers to exclude. */
const GENERIC_PATTERNS = [
  /^work with us$/i,
  /^spontaneous application$/i,
  /^open application$/i,
  /^candidatura spontanea$/i,
  /^candidature spontanee$/i,
  /^initiativbewerbung$/i,
];

function isGenericOffer(offer = {}) {
  const title = String(offer.title || '').trim();
  if (title.length < 5) return true;
  return GENERIC_PATTERNS.some((re) => re.test(title));
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch offers from the Recruitee API with timeout and error handling.
 * @returns {Array<object>} Raw offer objects from the API, or empty array on failure.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${API_URL}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`   ⚠️ HTTP ${res.status} from Recruitee API`);
      return [];
    }
    const data = await res.json();
    const offers = data?.offers || [];
    // Include ALL offers (remote company registered in Lugano) — filter only generic placeholders
    return offers.filter((o) => !isGenericOffer(o));
  } catch (err) {
    console.warn(`   ⚠️ Fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch all Tether Operations jobs from the Recruitee API.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllTetherJobs() {
  console.log(`🔍 Fetching Tether Operations jobs`);
  console.log(`   Source: ${API_URL}\n`);

  const offers = await fetchJobListings();
  if (!offers || offers.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Offers found: ${offers.length}`);

  const jobs = [];
  for (const offer of offers) {
    const title = normalizeSpace(offer.title || '');
    if (!title || title.length < 3) continue;

    // Combine all description sections (description + requirements + education + experience)
    const combinedHtml = combineDescriptionSections(offer);
    const descriptionText = stripHtml(combinedHtml || offer.description || '');

    // Extract location — remote company, default to Lugano HQ
    const firstLoc = offer.locations?.[0] || {};
    const city = normalizeSpace(firstLoc.city || HQ.city);
    const state = normalizeSpace(firstLoc.state || 'Ticino');
    const location = `${city}, ${state}`;

    // Work model — Tether is remote-first
    let workModel = 'remote';
    if (offer.on_site) workModel = 'on-site';
    else if (offer.hybrid) workModel = 'hybrid';

    // Employment type from Recruitee's employment_type_code
    const employmentType = EMPLOYMENT_TYPE_MAP[offer.employment_type_code] || 'FULL_TIME';

    // Date
    const datePosted = offer.published_at
      ? String(offer.published_at).slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    // Build detail + apply URLs
    const detailUrl = `${DETAIL_URL_BASE}/${offer.slug}`;
    const applyUrl = offer.careers_apply_url || detailUrl;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} tether ch`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    const fallbackDesc = `${title} — open position at Tether Operations. Tether is a pioneer in digital asset technology, registered in Lugano, Canton Ticino. Remote-first company building products used by millions. Apply through the official Tether careers page.`;

    const job = {
      // ── Required fields ──
      id: `tether-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TETHER_COMPANY_NAME,
      companyKey: TETHER_KEY,
      companyDomain: TETHER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || fallbackDesc,
      descriptionByLocale: { [sourceLang]: descriptionText || fallbackDesc },
      location,
      canton: HQ.canton,
      url: detailUrl,
      source: 'tether-careers-crawler',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      postalCode: HQ.postalCode,
      country: 'CH',
      category: detectCategory(title),
      contract: workModel === 'remote' ? 'remote' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      workModel,
      sector: 'Fintech / Blockchain',
      currency: 'CHF',
      featured: false,
      datePosted,
      postedDate: datePosted,
      applyUrl,
      department: offer.department || '',
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Tether Operations jobs discovered: ${jobs.length}`);
  return jobs;
}

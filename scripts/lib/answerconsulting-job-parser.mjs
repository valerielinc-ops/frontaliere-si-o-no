#!/usr/bin/env node
/**
 * AnswerConsulting SA job parser — Workable ATS (account slug "answermodules").
 *
 * AnswerConsulting SA (branded "AnswerModules" for its OpenText™ Enterprise
 * Content Management module suite) is a small Swiss ICT/software house
 * headquartered in Mendrisio, Ticino (Via Penate 4, 6850 Mendrisio). It
 * publishes openings on a public Workable account; no auth required.
 *
 * NOTE: the corporate site's careers page (answerconsulting.ch/careers) is a
 * Webflow CMS collection that mirrors postings manually and can go stale —
 * confirmed live: it still displayed a "R&D Software Engineer" card linking
 * to shortcode 86EE20F0FD, but that shortcode 404s ("Job not found") on the
 * Workable v2 detail API and the account has zero jobs in the widget feed.
 * The Workable API (widget + v2 detail), not the Webflow HTML, is therefore
 * the source of truth used here — it is live-authoritative and will surface
 * new postings automatically as soon as the company publishes them.
 *
 *   Widget v1 (discovery/listing):
 *     GET https://apply.workable.com/api/v1/widget/accounts/answermodules
 *     → { name, description, jobs: [{ title, shortcode, employment_type,
 *          department, url, published_on, country, city, locations: [...] }] }
 *     Multi-location jobs repeat the SAME shortcode once per location row —
 *     must dedupe on shortcode before fetching detail.
 *
 *   Detail v2 (per job, full description):
 *     GET https://apply.workable.com/api/v2/accounts/answermodules/jobs/{shortcode}
 *     → { title, shortcode, location, locations: [...], department,
 *          workplace, published, description (full HTML) }
 *
 * No shared ATS client exists for Workable under ./ats-clients/ (only
 * Greenhouse/Lever/SmartRecruiters/SuccessFactors/Workday) — this bespoke
 * fetch logic mirrors the existing hand-rolled Workable siblings
 * (debiopharm-job-parser.mjs, guess-job-parser.mjs, sophia-genetics-job-parser.mjs).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAnswerConsultingJobs() — Fetch and parse all Swiss jobs
 *   - isAnswerConsultingJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()              — Validate URLs belong to this company
 *   - slugify() / stripHtml()        — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';
import { isChCountry } from './ch-country-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ANSWERCONSULTING_KEY = 'answerconsulting';
export const ANSWERCONSULTING_COMPANY_NAME = 'AnswerConsulting SA';
export const ANSWERCONSULTING_COMPANY_DOMAIN = 'answerconsulting.ch';

const WORKABLE_ACCOUNT_SLUG = 'answermodules';
const WIDGET_API_URL = `https://apply.workable.com/api/v1/widget/accounts/${WORKABLE_ACCOUNT_SLUG}`;
const DETAIL_API_BASE = `https://apply.workable.com/api/v2/accounts/${WORKABLE_ACCOUNT_SLUG}/jobs`;

/* ── HQ fallback (Via Penate 4, 6850 Mendrisio, Ticino) ──────── */

const HQ = {
  city: 'Mendrisio',
  canton: 'TI',
  postalCode: '6850',
  streetAddress: 'Via Penate 4',
  region: 'Ticino',
};

const SECTOR = 'ICT / Enterprise Content Management';

/* ── Helpers ──────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString().split('T')[0];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  return d.toISOString().split('T')[0];
}

/* ── Company Matchers ─────────────────────────────────────── */

/**
 * Check if a job belongs to AnswerConsulting SA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAnswerConsultingJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ANSWERCONSULTING_KEY ||
    key.startsWith('answerconsulting') ||
    company.includes('answerconsulting') ||
    company.includes('answer consulting') ||
    company.includes('answermodules') ||
    url.includes('answerconsulting.ch') ||
    url.includes('answermodules.com') ||
    url.includes(`apply.workable.com/${WORKABLE_ACCOUNT_SLUG}`)
  );
}

/**
 * Validate that a URL belongs to AnswerConsulting's domain(s) OR the Workable
 * ATS host that actually serves the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'answerconsulting.ch' || host.endsWith('.answerconsulting.ch')) return true;
    if (host === 'answermodules.com' || host.endsWith('.answermodules.com')) return true;
    if (host === 'workable.com' || host.endsWith('.workable.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ───────────────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(`${title} ${department}`);
  if (/\b(scientist|research|researcher|r&d|r&amp;d)/.test(t)) return 'Ricerca e Sviluppo';
  if (/\b(ingegner|engineer|entwickl|develop|software)/.test(t)) return 'IT';
  if (/\b(techni|tecnic|support|assistenza)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account(ing|ant))/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|business development|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(hr|human|risorse|personal|talent)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'IT';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|apprendist|lehrling|lernend|apprenti|stage|stagiair)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|principal|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function normalizeAnswerConsultingEmploymentType(rawType = '', title = '') {
  const t = normalize(`${rawType} ${title}`);
  if (/\b(intern|apprenti|apprendist|stage|stagiair)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ────────────────────────────────────────── */

export function buildAnswerConsultingDetailUrl(shortcode) {
  return `${DETAIL_API_BASE}/${encodeURIComponent(shortcode)}`;
}

export function buildAnswerConsultingApplyUrl(shortcode) {
  return `https://apply.workable.com/${WORKABLE_ACCOUNT_SLUG}/j/${encodeURIComponent(shortcode)}/`;
}

/**
 * Dedupe the widget's job rows by shortcode (multi-location postings repeat
 * the same shortcode once per location row) and keep the employment type
 * label from the first occurrence.
 */
export function parseAnswerConsultingWidgetPayload(payload) {
  const rawJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const byShortcode = new Map();
  for (const raw of rawJobs) {
    if (!raw || typeof raw !== 'object' || !raw.shortcode) continue;
    if (byShortcode.has(raw.shortcode)) continue;
    byShortcode.set(raw.shortcode, {
      title: raw.title || '',
      shortcode: raw.shortcode,
      employmentType: raw.employment_type || '',
      department: raw.department || '',
      publishedDate: raw.published_on || raw.created_at || '',
    });
  }
  return Array.from(byShortcode.values());
}

/**
 * Resolve the Swiss location for a Workable detail payload, scanning
 * `locations[]` for a non-hidden CH entry rather than trusting only the
 * primary `location` field (mirrors the sophia-genetics/debiopharm siblings —
 * multi-location Workable postings are not guaranteed to put the CH entry
 * first). Falls back to the documented Mendrisio HQ when no location data is
 * present at all (single-office company; absence of location data on a
 * listed job should not silently drop it).
 *
 * Returns { city, region, countryCode: 'CH' } or null when the posting has
 * explicit location data that is NOT Switzerland (i.e. a foreign-office-only
 * posting under the same Workable account).
 */
export function resolveAnswerConsultingLocation(detail) {
  const candidates = [];
  if (Array.isArray(detail?.locations) && detail.locations.length > 0) {
    candidates.push(...detail.locations);
  } else if (detail?.location) {
    candidates.push(detail.location);
  }

  if (candidates.length === 0) {
    return { city: HQ.city, region: HQ.region, countryCode: 'CH' };
  }

  const visible = candidates.filter((loc) => loc && !loc.hidden && isChCountry(loc.countryCode || loc.country));
  const hidden = candidates.filter((loc) => loc && loc.hidden && isChCountry(loc.countryCode || loc.country));
  const match = visible[0] || hidden[0];
  if (!match) return null; // every listed location is non-Swiss

  return {
    city: normalizeSpace(match.city || '') || HQ.city,
    region: normalizeSpace(match.region || '') || HQ.region,
    countryCode: 'CH',
  };
}

export function isAnswerConsultingSwissJob(detail) {
  return resolveAnswerConsultingLocation(detail) !== null;
}

/**
 * Pick the best city / postal code / street for a resolved Swiss location,
 * falling back to the documented HQ address (Mendrisio) ONLY when the
 * resolved CITY is actually Mendrisio — canton-level matching would leak the
 * HQ street address onto any other TI-canton city.
 */
function resolveAddress(city) {
  const resolvedCity = city || HQ.city;
  const isHqCity = /mendrisio/i.test(resolvedCity);
  return {
    city: resolvedCity,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
  };
}

/**
 * Fetch all AnswerConsulting SA jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllAnswerConsultingJobs() {
  console.log(`🔍 Fetching ${ANSWERCONSULTING_COMPANY_NAME} jobs`);
  console.log(`   Source: ${WIDGET_API_URL}\n`);

  const widgetPayload = await fetchJson(WIDGET_API_URL);
  const listings = parseAnswerConsultingWidgetPayload(widgetPayload);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned (0 current openings on Workable).');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    let detail;
    try {
      detail = await fetchJson(buildAnswerConsultingDetailUrl(listing.shortcode));
    } catch (err) {
      console.warn(`  ⚠️  Detail fetch failed for ${listing.shortcode}: ${err?.message || err}`);
      continue;
    }

    const swissLocation = resolveAnswerConsultingLocation(detail);
    if (!swissLocation) continue; // not Switzerland-located

    const canton =
      inferSwissTargetCanton(swissLocation.city) ||
      inferAnyCanton(`${swissLocation.city} ${swissLocation.region}`) ||
      HQ.canton;
    const { city, postalCode, streetAddress } = resolveAddress(swissLocation.city);
    const location = normalizeSpace(city);

    const descriptionHtml = detail?.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildAnswerConsultingApplyUrl(listing.shortcode);
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const description = descriptionText || `${title} — ${ANSWERCONSULTING_COMPANY_NAME}, ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} answerconsulting ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const department = Array.isArray(detail?.department) ? detail.department.join(' ') : (detail?.department || listing.department || '');
    const employmentType = normalizeAnswerConsultingEmploymentType(listing.employmentType, title);
    const postedDate = toIsoDate(detail?.published || listing.publishedDate);

    const job = {
      // ── Required fields ──
      id: `${ANSWERCONSULTING_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ANSWERCONSULTING_COMPANY_NAME,
      companyKey: ANSWERCONSULTING_KEY,
      companyDomain: ANSWERCONSULTING_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'AnswerConsulting Dedicated Parser (Workable)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressRegion: swissLocation.region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, department),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.shortcode || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${ANSWERCONSULTING_COMPANY_NAME} Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * SOPHiA GENETICS job parser — Workable ATS (account slug "sophia-genetics").
 *
 * SOPHiA GENETICS is a Swiss health-tech / genomics company (Data-Driven
 * Medicine, NGS/CDx analytics for hospitals) headquartered in Rolle, Vaud,
 * with a secondary Swiss presence in Zürich plus international offices
 * (Boston, Bidart FR, ...). Postings for the whole group live on a single
 * public Workable account; no auth required.
 *
 *   Widget v1 (discovery/listing):
 *     GET https://apply.workable.com/api/v1/widget/accounts/sophia-genetics
 *     → { name, description, jobs: [{ title, shortcode, employment_type,
 *          department, url, published_on, country, city, locations: [...] }] }
 *     Multi-location jobs repeat the SAME shortcode once per location row —
 *     must dedupe on shortcode before fetching detail.
 *
 *   Detail v2 (per job, full description):
 *     GET https://apply.workable.com/api/v2/accounts/sophia-genetics/jobs/{shortcode}
 *     → { title, shortcode, location, locations: [...], department,
 *          workplace, published, description (full HTML) }
 *     `detail.location` (primary) is NOT reliably the Swiss location for
 *     multi-location jobs — confirmed live: shortcode 39F1F5A7B1 has
 *     `location.countryCode === 'GB'` while a genuine CH entry only exists
 *     at `locations[2]`. Location resolution below explicitly scans
 *     `locations[]` for a non-hidden CH entry instead of trusting the
 *     primary `location` field or `locations[0]`.
 *
 * No shared ATS client exists for Workable under ./ats-clients/ (only
 * Greenhouse/Lever/SmartRecruiters/SuccessFactors/Workday) — this bespoke
 * fetch logic mirrors the existing hand-rolled Workable siblings
 * (debiopharm-job-parser.mjs, guess-job-parser.mjs).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSophiaGeneticsJobs() — Fetch and parse all Swiss jobs
 *   - isSophiaGeneticsJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()            — Validate URLs belong to this company
 *   - slugify() / stripHtml()      — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';
import { isChCountry } from './ch-country-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SOPHIA_GENETICS_KEY = 'sophia-genetics';
export const SOPHIA_GENETICS_COMPANY_NAME = 'SOPHiA GENETICS';
export const SOPHIA_GENETICS_COMPANY_DOMAIN = 'sophiagenetics.com';

const WORKABLE_ACCOUNT_SLUG = 'sophia-genetics';
const CAREER_URL = `https://apply.workable.com/${WORKABLE_ACCOUNT_SLUG}/`;
const WIDGET_API_URL = `https://apply.workable.com/api/v1/widget/accounts/${WORKABLE_ACCOUNT_SLUG}`;
const DETAIL_API_BASE = `https://apply.workable.com/api/v2/accounts/${WORKABLE_ACCOUNT_SLUG}/jobs`;

/* ── HQ fallback (La Pièce 12, 1180 Rolle, VD) ───────────────── */

const HQ = {
  city: 'Rolle',
  canton: 'VD',
  postalCode: '1180',
  streetAddress: 'La Pièce 12',
  region: 'Vaud',
};

const SECTOR = 'Health-Tech / Genomica';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString().split('T')[0];
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  return d.toISOString().split('T')[0];
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to SOPHiA GENETICS.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSophiaGeneticsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SOPHIA_GENETICS_KEY ||
    key.startsWith('sophia-genetics') ||
    company.includes('sophia genetics') ||
    company.includes('sophiagenetics') ||
    url.includes('sophiagenetics.com') ||
    url.includes(`apply.workable.com/${WORKABLE_ACCOUNT_SLUG}`)
  );
}

/**
 * Validate that a URL belongs to SOPHiA GENETICS's domain OR the Workable
 * ATS hosts that actually serve the postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'sophiagenetics.com' || host.endsWith('.sophiagenetics.com')) return true;
    if (host === 'workable.com' || host.endsWith('.workable.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(`${title} ${department}`);
  if (/\b(scientist|research|researcher|r&d|bioinformatic|genomic|ngs\b)/.test(t)) return 'Ricerca';
  if (/\b(ingegner|engineer|entwickl|develop)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|lab technician|quality control)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account(ing|ant))/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|business development|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply chain)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality|regulatory|validation)/.test(t)) return 'Qualità';
  if (/\b(it|software|program|data science|machine learning)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|talent)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|apprendist|lehrling|lernend|apprenti|stage|stagiair)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|principal|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function normalizeSophiaGeneticsEmploymentType(rawType = '', title = '') {
  const t = normalize(`${rawType} ${title}`);
  if (/\b(intern|apprenti|apprendist|stage|stagiair)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

export function buildSophiaGeneticsDetailUrl(shortcode) {
  return `${DETAIL_API_BASE}/${encodeURIComponent(shortcode)}`;
}

export function buildSophiaGeneticsApplyUrl(shortcode) {
  return `https://apply.workable.com/${WORKABLE_ACCOUNT_SLUG}/j/${encodeURIComponent(shortcode)}/`;
}

/**
 * Dedupe the widget's job rows by shortcode (multi-location postings repeat
 * the same shortcode once per location row) and keep the employment type
 * label from the first occurrence.
 */
export function parseSophiaGeneticsWidgetPayload(payload) {
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
 * Explicitly search a Workable detail payload's `locations[]` for a
 * non-hidden Swiss (CH) entry, rather than trusting the primary `location`
 * field or `locations[0]` — the primary location is NOT reliably Swiss for
 * multi-location postings (confirmed live: a UK-primary job also lists a
 * genuine CH row deeper in `locations[]`).
 *
 * Returns { city, region, countryCode: 'CH' } or null when no CH entry
 * exists among the posting's locations.
 */
export function resolveSophiaGeneticsSwissLocation(detail) {
  const candidates = [];
  if (Array.isArray(detail?.locations) && detail.locations.length > 0) {
    candidates.push(...detail.locations);
  } else if (detail?.location) {
    candidates.push(detail.location);
  }

  const visible = candidates.filter((loc) => loc && !loc.hidden && isChCountry(loc.countryCode || loc.country));
  const hidden = candidates.filter((loc) => loc && loc.hidden && isChCountry(loc.countryCode || loc.country));
  const match = visible[0] || hidden[0];
  if (!match) return null;

  return {
    city: normalizeSpace(match.city || ''),
    region: normalizeSpace(match.region || ''),
    countryCode: 'CH',
  };
}

export function isSophiaGeneticsSwissJob(detail) {
  return resolveSophiaGeneticsSwissLocation(detail) !== null;
}

/**
 * Pick the best city / postal code / street / region for a resolved Swiss
 * location, falling back to the documented HQ address (Rolle VD) ONLY when
 * the resolved CITY is actually Rolle — canton-level matching would leak
 * the Rolle street address onto any other VD-canton city.
 */
function resolveAddress(city, canton) {
  const resolvedCity = city || HQ.city;
  const isHqCity = /rolle/i.test(resolvedCity);
  return {
    city: resolvedCity,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
  };
}

/**
 * Fetch all SOPHiA GENETICS jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSophiaGeneticsJobs() {
  console.log(`🔍 Fetching ${SOPHIA_GENETICS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${WIDGET_API_URL}\n`);

  const widgetPayload = await fetchJson(WIDGET_API_URL);
  const listings = parseSophiaGeneticsWidgetPayload(widgetPayload);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
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
      detail = await fetchJson(buildSophiaGeneticsDetailUrl(listing.shortcode));
    } catch (err) {
      console.warn(`  ⚠️  Detail fetch failed for ${listing.shortcode}: ${err?.message || err}`);
      continue;
    }

    const swissLocation = resolveSophiaGeneticsSwissLocation(detail);
    if (!swissLocation) continue; // not Switzerland-located

    const canton =
      inferSwissTargetCanton(swissLocation.city) ||
      inferAnyCanton(`${swissLocation.city} ${swissLocation.region}`) ||
      HQ.canton;
    const { city, postalCode, streetAddress } = resolveAddress(swissLocation.city, canton);
    const location = normalizeSpace(city);

    const descriptionHtml = detail?.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = buildSophiaGeneticsApplyUrl(listing.shortcode);
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const description = descriptionText || `${title} — ${SOPHIA_GENETICS_COMPANY_NAME}, ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} sophia genetics ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const department = Array.isArray(detail?.department) ? detail.department.join(' ') : (detail?.department || listing.department || '');
    const employmentType = normalizeSophiaGeneticsEmploymentType(listing.employmentType, title);
    const postedDate = toIsoDate(detail?.published || listing.publishedDate);

    const job = {
      // ── Required fields ──
      id: `${SOPHIA_GENETICS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SOPHIA_GENETICS_COMPANY_NAME,
      companyKey: SOPHIA_GENETICS_KEY,
      companyDomain: SOPHIA_GENETICS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'SOPHiA GENETICS Dedicated Parser (Workable)',
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

  console.log(`\n📋 Total ${SOPHIA_GENETICS_COMPANY_NAME} Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * CERN job parser — SmartRecruiters (tenant "CERN") API.
 *
 * Source: https://careers.cern (public career page; the SR API discovery
 * below is what actually feeds this parser)
 *
 * CERN (Organisation Européenne pour la Recherche Nucléaire) is the
 * international particle-physics research organisation headquartered at
 * Meyrin GE, straddling the Swiss/French border. The public REST API at
 *   https://api.smartrecruiters.com/v1/companies/CERN/postings
 * exposes every active posting; `locationCountryCodes: ['ch']` narrows to
 * the Swiss-side subset (postings list city "Geneva", region "GENEVA",
 * country "ch"). Per-posting detail (full jobAd description + street
 * address) lives at `/postings/{id}` and is fetched on demand.
 *
 * Tenant discovery note: the plain "CERN" tenant id matches directly
 * (totalFound: 60 verified live), no alternate tenant needed.
 *
 * Public posting URLs are jobs.smartrecruiters.com/CERN/{id}-{slug}.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCernJobs()     — Fetch and parse all Swiss jobs
 *   - isCernJob()            — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CERN_KEY = 'cern';
export const CERN_COMPANY_NAME = 'CERN';
export const CERN_COMPANY_DOMAIN = 'home.cern';

const SR_TENANT = 'CERN';
const CAREER_URL = 'https://careers.cern';

/* ── HQ fallback (Meyrin, GE) ─────────────────────────────────── */

const HQ = {
  city: 'Meyrin',
  canton: 'GE',
  postalCode: '1211',
  streetAddress: 'Esplanade des Particules 1',
  region: 'Genève',
};

const SECTOR = 'Ricerca / Scienza';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to CERN.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCernJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CERN_KEY ||
    company === 'cern' ||
    url.includes('home.cern') ||
    url.includes('careers.cern') ||
    url.includes('smartrecruiters.com/cern')
  );
}

/**
 * Validate that a URL belongs to CERN's domain OR the SmartRecruiters
 * ATS hosts that actually serve the postings (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'home.cern' || host.endsWith('.home.cern')) return true;
    if (host === 'careers.cern' || host.endsWith('.cern')) return true;
    if (host === 'smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(physic|physik|fisic|research|ricerc|recherche)/.test(t)) return 'Ricerca';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|comput)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|fellow|studentship|doctoral|phd)/.test(t)) return 'intern';
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Pick the best city / postal code / street / region from a raw
 * SmartRecruiters posting location, falling back to the documented HQ
 * address (Meyrin GE) when a field is missing.
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const streetAddress = (rawLoc.address || '').trim();
  const region = (rawLoc.region || '').trim();

  return {
    city: city || HQ.city,
    postalCode: postalCode || (!city || /gen[eè]v|meyrin/i.test(city) ? HQ.postalCode : ''),
    streetAddress: streetAddress || (!city || /gen[eè]v|meyrin/i.test(city) ? HQ.streetAddress : ''),
    region,
  };
}

/**
 * Fetch the Switzerland-only CERN postings from the SmartRecruiters API
 * (tenant "CERN", country=ch). Returns an array of raw listing objects
 * {title, location, url, postedAt, description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`   Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const listings = [];
  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: CERN_COMPANY_NAME,
      locationCountryCodes: ['ch'],
      fetchDetail: true,
      timeoutMs,
    })) {
      const raw = job.rawPosting || {};
      listings.push({
        title: job.title,
        location: job.location,
        url: job.applyUrl,
        postedAt: job.postedAt,
        description: job.descriptionHtml || '',
        jobReqId: job.jobReqId || raw.id || '',
        rawLocation: raw.location || {},
        employmentLabel: raw?.typeOfEmployment?.label || '',
      });
    }
  } catch (err) {
    console.warn(`⚠️ SmartRecruiters fetch failed: ${err?.message || err}`);
    throw err;
  }

  return listings;
}

/**
 * Fetch all CERN jobs (Switzerland-side only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCernJobs() {
  console.log(`🔍 Fetching ${CERN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
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

    const { city, postalCode, streetAddress, region } = resolveAddress(listing.rawLocation);
    const location = normalizeSpace(listing.location || city || HQ.city);
    const canton =
      inferSwissTargetCanton(location) ||
      inferSwissTargetCanton(`${city} ${region}`) ||
      HQ.canton;

    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const description = descriptionText || `${title} at ${CERN_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} cern ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${CERN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CERN_COMPANY_NAME,
      companyKey: CERN_KEY,
      companyDomain: CERN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: 'CERN Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${CERN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Hospice général job parser — SmartRecruiters (tenant "Hospicegeneral") API.
 *
 * Source: https://www.hospicegeneral.ch (public site; careers hosted on
 * careers.smartrecruiters.com/Hospicegeneral — SR API discovery below is
 * what actually feeds this parser)
 *
 * Hospice général is Geneva canton's public social-services institution
 * (cantonal social welfare, asylum/migrant support, senior services),
 * headquartered at Cours de Rive 12, 1204 Genève. The public REST API at
 *   https://api.smartrecruiters.com/v1/companies/Hospicegeneral/postings
 * exposes every active posting; `locationCountryCodes: ['ch']` narrows to
 * the Swiss subset (postings observed span Geneva GE and Vaud VD — Hospice
 * général runs some vacation/senior facilities outside Geneva canton).
 * Per-posting detail (full jobAd description + street address) lives at
 * `/postings/{id}` and is fetched on demand.
 *
 * Tenant discovery note: tenant id is "Hospicegeneral" (lowercase 'g',
 * no space — case-sensitive per SmartRecruiters API), confirmed live
 * (totalFound: 4 — small volume is expected for this institution, build
 * the crawler anyway per backlog #3337).
 *
 * Public posting URLs are jobs.smartrecruiters.com/Hospicegeneral/{id}-{slug}.
 * Postings are predominantly French (Geneva), so sourceLang is detected
 * per-job via detectLang with a French fallback (mirrors staubli's German
 * fallback / cern's English fallback pattern).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHospiceGeneralJobs() — Fetch and parse all Swiss jobs
 *   - isHospiceGeneralJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()            — Validate URLs belong to this company
 *   - slugify() / stripHtml()      — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOSPICE_GENERAL_KEY = 'hospice-general';
export const HOSPICE_GENERAL_COMPANY_NAME = 'Hospice général';
export const HOSPICE_GENERAL_COMPANY_DOMAIN = 'hospicegeneral.ch';

const SR_TENANT = 'Hospicegeneral';
const CAREER_URL = 'https://careers.smartrecruiters.com/Hospicegeneral';

/* ── HQ fallback (Cours de Rive 12, 1204 Genève) ──────────────── */

const HQ = {
  city: 'Genève',
  canton: 'GE',
  postalCode: '1204',
  streetAddress: 'Cours de Rive 12',
  region: 'Genève',
};

const SECTOR = 'Servizi sociali / Pubblica amministrazione';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Hospice général.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHospiceGeneralJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HOSPICE_GENERAL_KEY ||
    company === 'hospice general' ||
    company.includes('hospice general') ||
    url.includes('hospicegeneral.ch') ||
    url.includes('smartrecruiters.com/hospicegeneral')
  );
}

/**
 * Validate that a URL belongs to Hospice général's domain OR the
 * SmartRecruiters ATS hosts that actually serve the postings
 * (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'hospicegeneral.ch' || host.endsWith('.hospicegeneral.ch')) return true;
    if (host === 'smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(social|assistant social|educat|animat|assistance)/.test(t)) return 'Sociale';
  if (/\b(civiliste|service civil)/.test(t)) return 'Servizio civile';
  if (/\b(senior|séniors|seniors|personnes âgées|anziani)/.test(t)) return 'Servizi Anziani';
  if (/\b(migrant|asile|asilo|réfugié)/.test(t)) return 'Migrazione / Asilo';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|comput)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|rh)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|civiliste)/.test(t)) return 'intern';
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
 * address (Cours de Rive 12, Genève) when a field is missing.
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const streetAddress = (rawLoc.address || '').trim();
  const region = (rawLoc.region || '').trim();

  return {
    city: city || HQ.city,
    postalCode: postalCode || (!city || /gen[eè]v/i.test(city) ? HQ.postalCode : ''),
    streetAddress: streetAddress || (!city || /gen[eè]v/i.test(city) ? HQ.streetAddress : ''),
    region,
  };
}

/**
 * Fetch the Switzerland-only Hospice général postings from the
 * SmartRecruiters API (tenant "Hospicegeneral", country=ch). Returns an
 * array of raw listing objects {title, location, url, postedAt,
 * description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`   Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const listings = [];
  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: HOSPICE_GENERAL_COMPANY_NAME,
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
 * Fetch all Hospice général jobs (Switzerland-only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHospiceGeneralJobs() {
  console.log(`🔍 Fetching ${HOSPICE_GENERAL_COMPANY_NAME} jobs`);
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

    const description = descriptionText || `${title} chez ${HOSPICE_GENERAL_COMPANY_NAME} à ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} hospice general ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${HOSPICE_GENERAL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HOSPICE_GENERAL_COMPANY_NAME,
      companyKey: HOSPICE_GENERAL_KEY,
      companyDomain: HOSPICE_GENERAL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Hospice général Dedicated Parser (SmartRecruiters)',
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

  console.log(`\n📋 Total ${HOSPICE_GENERAL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

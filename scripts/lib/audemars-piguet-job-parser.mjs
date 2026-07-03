#!/usr/bin/env node
/**
 * Audemars Piguet job parser — SmartRecruiters (tenant "AudemarsPiguet") API.
 *
 * Source: https://careers.audemarspiguet.com/en/home
 *
 * Audemars Piguet (independent, family-owned fine watchmaking, HQ Le Brassus/VD)
 * serves jobs on its own SmartRecruiters tenant. The public REST API at
 *   https://api.smartrecruiters.com/v1/companies/AudemarsPiguet/postings
 * exposes every active posting; the `country=ch` filter narrows to the Swiss
 * postings (Le Brassus/VD, Le Locle/NE, Meyrin/GE). Per-posting detail (full
 * jobAd description) lives at `/postings/{id}` and is fetched on demand.
 *
 * Public posting URLs are jobs.smartrecruiters.com/AudemarsPiguet/{id}-{slug}.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAudemarsPiguetJobs()  — Fetch and parse all jobs
 *   - isAudemarsPiguetJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const AUDEMARS_PIGUET_KEY = 'audemars-piguet';
export const AUDEMARS_PIGUET_COMPANY_NAME = 'Audemars Piguet';
export const AUDEMARS_PIGUET_COMPANY_DOMAIN = 'audemarspiguet.com';

const SR_TENANT = 'AudemarsPiguet';
const CAREER_URL = 'https://careers.audemarspiguet.com/en/home';

/* ── HQ fallback (Route de France 16, 1348 Le Brassus, VD) ──── */

const HQ = {
  city: 'Le Brassus',
  canton: 'VD',
  postalCode: '1348',
  region: 'Vaud',
};

const SECTOR = 'Luxury / Fine Watchmaking';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Audemars Piguet.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAudemarsPiguetJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === AUDEMARS_PIGUET_KEY ||
    key.startsWith('audemars-piguet') ||
    company.includes('audemars piguet') ||
    url.includes('audemarspiguet.com')
  );
}

/**
 * Validate that a URL belongs to Audemars Piguet's domain OR the SmartRecruiters
 * ATS hosts that actually serve the postings (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'audemarspiguet.com' || host.endsWith('.audemarspiguet.com')) return true;
    if (host === 'smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) return true;
    return false;
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Pick the best postal code / region / city from a raw SmartRecruiters posting
 * location, falling back to the documented HQ address. The recon flags that one
 * Le Brassus posting reports the geocoding artifact 1814 (misspelled "Le
 * Brasssus") — for Le Brassus we pin the correct 1348.
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  let postalCode = (rawLoc.postalCode || '').trim();
  const region = (rawLoc.region || '').trim();

  // Le Brassus geocoding artifact guard (1814 ⇒ misspelled city) → canonical 1348.
  if (/le\s*brass+us/i.test(city)) postalCode = HQ.postalCode;

  return {
    city: city || HQ.city,
    postalCode: postalCode || (/le\s*brass+us/i.test(city) ? HQ.postalCode : ''),
    region: region || '',
  };
}

/**
 * Fetch the Switzerland-only Audemars Piguet postings from the SmartRecruiters
 * API (tenant "AudemarsPiguet", country=ch). Returns an array of raw listing
 * objects {title, location, url, postedAt, description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`   Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const listings = [];
  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: AUDEMARS_PIGUET_COMPANY_NAME,
      locationCountryCodes: ['CH'],
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
 * Fetch all Audemars Piguet jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllAudemarsPiguetJobs() {
  console.log(`🔍 Fetching Audemars Piguet jobs`);
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

    const { city, postalCode, region } = resolveAddress(listing.rawLocation);
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

    const description = descriptionText || `${title} bei ${AUDEMARS_PIGUET_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} audemars-piguet ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${AUDEMARS_PIGUET_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: AUDEMARS_PIGUET_COMPANY_NAME,
      companyKey: AUDEMARS_PIGUET_KEY,
      companyDomain: AUDEMARS_PIGUET_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Audemars Piguet Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
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

  console.log(`\n📋 Total ${AUDEMARS_PIGUET_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

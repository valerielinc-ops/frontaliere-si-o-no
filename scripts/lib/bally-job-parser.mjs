#!/usr/bin/env node
/**
 * Bally job parser — SmartRecruiters (tenant "Bally") API.
 *
 * Source: https://jobs.smartrecruiters.com/Bally
 *
 * Bally (Swiss luxury leather-goods house, HQ Caslano/TI) posts openings on
 * its own SmartRecruiters tenant. The public REST API at
 *   https://api.smartrecruiters.com/v1/companies/Bally/postings
 * exposes every active posting worldwide; we filter to CH-located roles
 * client-side via fetchSmartRecruitersJobs' locationCountryCodes option.
 *
 * The 4 legacy bally.com/en-ch/careers.html-style URLs this crawler used to
 * probe are all dead (404) — Bally's own site has no job-listing page at
 * all, only a static "/pages/careers" marketing/GDPR page that links out to
 * this SmartRecruiters tenant (#3797).
 *
 * Public posting URLs are jobs.smartrecruiters.com/Bally/{id}-{slug}.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBallyJobs()  — Fetch and parse all jobs
 *   - isBallyJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BALLY_KEY = 'bally';
export const BALLY_COMPANY_NAME = 'Bally';
export const BALLY_COMPANY_DOMAIN = 'bally.com';

const SR_TENANT = 'Bally';
const CAREER_URL = 'https://jobs.smartrecruiters.com/Bally';
const HQ = getCompanyDefaults('bally');

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Bally.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBallyJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BALLY_KEY ||
    key.startsWith('bally') ||
    company.includes('bally') ||
    url.includes('bally.com')
  );
}

/**
 * Validate that a URL belongs to Bally's domain OR the SmartRecruiters
 * ATS hosts that actually serve the postings (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'bally.com' || host.endsWith('.bally.com')) return true;
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
 * Fetch the Switzerland-only Bally postings from the SmartRecruiters API
 * (tenant "Bally", country=ch). Returns an array of raw listing objects
 * {title, location, url, postedAt, description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`   Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const listings = [];
  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: BALLY_COMPANY_NAME,
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
 * Fetch all Bally jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBallyJobs() {
  console.log(`🔍 Fetching Bally jobs`);
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

    const rawLoc = listing.rawLocation || {};
    const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
    const region = (rawLoc.region || '').trim();
    const location = normalizeSpace(listing.location || city || HQ?.city || 'Caslano');
    const canton =
      inferSwissTargetCanton(location) ||
      inferSwissTargetCanton(`${city} ${region}`) ||
      HQ?.canton ||
      'TI';

    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} bally ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const desc = descriptionText || `${title} — Position at Bally, ${location}. Bally is a Swiss luxury fashion house founded in 1851, headquartered in Caslano (Ticino), known for its leather goods and footwear.`;

    const job = {
      id: `bally-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BALLY_COMPANY_NAME,
      companyKey: BALLY_KEY,
      companyDomain: BALLY_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Bally Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city || location,
      addressRegion: region || HQ?.addressRegion || canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: rawLoc.postalCode || HQ?.postalCode || '6987',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Moda / Lusso',
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

  console.log(`\n📋 Total Bally jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Talan job parser — SmartRecruiters (tenant "Talan") API.
 *
 * Source: https://careers.smartrecruiters.com/Talan
 *
 * Talan is a global IT/SAP/AI consulting group (Paris HQ) with a Geneva
 * office serving the Swiss market. The public REST API at
 *   https://api.smartrecruiters.com/v1/companies/Talan/postings
 * exposes every active posting (mostly France); the `country=ch` filter
 * narrows to the ~9 Swiss postings (Geneva). Per-posting detail (full jobAd
 * description) lives at `/postings/{id}` and is fetched on demand.
 *
 * Public posting URLs are jobs.smartrecruiters.com/Talan/{id}-{slug}.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllTalanJobs()  — Fetch and parse all jobs
 *   - isTalanJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to this company
 *   - TALAN_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const TALAN_KEY = 'talan';
export const TALAN_COMPANY_NAME = 'Talan';
export const TALAN_COMPANY_DOMAIN = 'talan.com';

const SR_TENANT = 'Talan';
const CAREER_URL = `https://careers.smartrecruiters.com/${SR_TENANT}`;

/* ── HQ fallback (Geneva office) ──────────────────────────── */

const HQ = {
  city: 'Genève',
  canton: 'GE',
  postalCode: '1204',
  region: 'Genève',
};

const SECTOR = 'IT / SAP / AI Consulting';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Talan.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isTalanJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === TALAN_KEY ||
    key.startsWith('talan') ||
    company === 'talan' ||
    url.includes('talan.com') ||
    url.includes('smartrecruiters.com/talan')
  );
}

/**
 * Validate that a URL belongs to Talan's domain OR the SmartRecruiters
 * ATS hosts that actually serve the postings (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'talan.com' || host.endsWith('.talan.com')) return true;
    if (host === 'smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) {
      return /\/talan(\/|$)/i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(sap|abap|fiori|s\/4hana|btp)/.test(t)) return 'IT';
  if (/\b(ia|ai\b|intelligence artificielle|copilot|data|machine learning)/.test(t)) return 'IT';
  if (/\b(cloud|ingegner|engineer|develop|programm|entwickl|informatique)/.test(t)) return 'IT';
  if (/\b(dba|architect|architecte)/.test(t)) return 'IT';
  if (/\b(consult|conseil)/.test(t)) return 'Consulenza';
  if (/\b(admin|segret|contab|buchhalt|account|comptab)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|business developer)/.test(t)) return 'Commerciale';
  if (/\b(hr|human|risorse|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(market|kommunik|comunicaz|communication)/.test(t)) return 'Marketing';
  return 'IT';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/\b(stage|intern|stagiair|apprenti)/.test(t)) return 'INTERN';
  if (/\b(cdd|temporary|tempor|befristet|fixed.?term|long term contract)/.test(t)) return 'CONTRACTOR';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Pick the best postal code / region / city from a raw SmartRecruiters
 * posting location, falling back to the documented Geneva HQ address.
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const region = (rawLoc.region || '').trim();

  return {
    city: city || HQ.city,
    postalCode,
    region: region || '',
  };
}

/**
 * Fetch the Switzerland-only Talan postings from the SmartRecruiters API
 * (tenant "Talan", country=ch). Returns an array of raw listing objects
 * {title, location, url, postedAt, description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`   Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const listings = [];
  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: TALAN_COMPANY_NAME,
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
 * Fetch all Talan jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllTalanJobs() {
  console.log(`🔍 Fetching Talan jobs`);
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

    const description = descriptionText || `${title} chez ${TALAN_COMPANY_NAME} à ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} talan ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${TALAN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TALAN_COMPANY_NAME,
      companyKey: TALAN_KEY,
      companyDomain: TALAN_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Talan Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      postalCode: postalCode || (/gen[eè]ve|geneva/i.test(location) ? HQ.postalCode : ''),
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

  console.log(`\n📋 Total ${TALAN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Oetiker job parser — SmartRecruiters (tenant "oetiker") API.
 *
 * Source: https://careers.smartrecruiters.com/oetiker (public career page;
 * the SR API discovery below is what actually feeds this parser)
 *
 * Oetiker is a global manufacturing group specialised in clamping and
 * connection systems (automotive, industrial, medical), headquartered in
 * Horgen ZH (Spätzstrasse 11, 8810 Horgen — Oetiker Schweiz AG, per the
 * company's own imprint page). It publishes postings for the whole group
 * on a single SmartRecruiters tenant, so Swiss postings also show up
 * mixed in with international sites. The public REST API at
 *   https://api.smartrecruiters.com/v1/companies/oetiker/postings
 * exposes every active posting worldwide (confirmed live: `totalFound: 37`
 * as of discovery); `locationCountryCodes: ['ch']` narrows to the Swiss
 * subset. Per-posting detail (full jobAd description + street address)
 * lives at `/postings/{id}` and is fetched on demand.
 *
 * Tenant discovery note: the lowercase "oetiker" tenant id (matching the
 * brand name) resolves directly against the public SR API — no probing of
 * alternate tenant ids was needed.
 *
 * Public posting URLs are jobs.smartrecruiters.com/oetiker/{id}-{slug}.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllOetikerJobs()  — Fetch and parse all Swiss jobs
 *   - isOetikerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchSmartRecruitersJobs } from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OETIKER_KEY = 'oetiker';
export const OETIKER_COMPANY_NAME = 'Oetiker';
export const OETIKER_COMPANY_DOMAIN = 'oetiker.com';

const SR_TENANT = 'oetiker';
const CAREER_URL = 'https://careers.smartrecruiters.com/oetiker';

/* ── HQ fallback (Spätzstrasse 11, 8810 Horgen, ZH) ──────────── */

const HQ = {
  city: 'Horgen',
  canton: 'ZH',
  postalCode: '8810',
  streetAddress: 'Spätzstrasse 11',
  region: 'Zürich',
};

const SECTOR = 'Industria / Manifattura';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Oetiker.
 * Used by the template to filter this company's jobs out of the global dataset.
 */
export function isOetikerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === OETIKER_KEY ||
    key.startsWith('oetiker') ||
    company.includes('oetiker') ||
    url.includes('oetiker.com') ||
    url.includes('smartrecruiters.com/oetiker')
  );
}

/**
 * Validate that a URL belongs to Oetiker's domain OR the SmartRecruiters
 * ATS hosts that actually serve the postings (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'oetiker.com' || host.endsWith('.oetiker.com')) return true;
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
  if (/\b(techni|tecnic|mecanic|elektr|install|meccatron|mechatron)/.test(t)) return 'Tecnica';
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
 * Pick the best city / postal code / street / region from a raw
 * SmartRecruiters posting location, falling back to the documented HQ
 * address (Horgen ZH) when a field is missing.
 */
function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const streetAddress = (rawLoc.address || '').trim();
  const region = (rawLoc.region || '').trim();

  return {
    city: city || HQ.city,
    postalCode: postalCode || (!city || /horgen/i.test(city) ? HQ.postalCode : ''),
    streetAddress: streetAddress || (!city || /horgen/i.test(city) ? HQ.streetAddress : ''),
    region,
  };
}

/**
 * Fetch the Switzerland-only Oetiker postings from the SmartRecruiters API
 * (tenant "oetiker", country=ch). Returns an array of raw listing
 * objects {title, location, url, postedAt, description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`   Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const listings = [];
  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: OETIKER_COMPANY_NAME,
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
 * Fetch all Oetiker jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllOetikerJobs() {
  console.log(`🔍 Fetching ${OETIKER_COMPANY_NAME} jobs`);
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

    const description = descriptionText || `${title} bei ${OETIKER_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} oetiker ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${OETIKER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OETIKER_COMPANY_NAME,
      companyKey: OETIKER_KEY,
      companyDomain: OETIKER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Oetiker Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress: streetAddress || (canton === HQ.canton ? HQ.streetAddress : ''),
      postalCode: postalCode || (canton === HQ.canton ? HQ.postalCode : ''),
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

  console.log(`\n📋 Total ${OETIKER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

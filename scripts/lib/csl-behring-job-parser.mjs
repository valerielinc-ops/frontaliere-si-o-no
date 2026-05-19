#!/usr/bin/env node
/**
 * CSL Behring job parser — Workday ATS (Swiss operations).
 *
 * Tenant host: csl.wd1.myworkdayjobs.com
 * Site path:   CSL_External
 * Career URL:  https://careers.cslbehring.com/
 *
 * CSL Behring (a division of Australian biotech CSL Limited) is a global
 * leader in plasma-derived and recombinant therapies. Swiss operations are
 * concentrated in canton Bern (Bern HQ for tech-ops/manufacturing) with
 * smaller R&D and commercial functions across CH. At the time of this
 * parser, the Workday tenant exposed ~55 open Swiss positions (the highest
 * volume of any single medtech/pharma in this sweep).
 *
 * Workday quirk: this tenant uses the standard `locationCountry` facet with
 * the canonical Swiss UUID `187134fccb084a0ea9b4b95f23890dbe`.
 *
 * Location text format: `EMEA, CH, Kanton Bern, Bern, CSL Behring` (region,
 * country code, canton, city, business unit). We split on commas and pick
 * the first segment that looks like a city. We also handle the "N Locations"
 * roll-up via fallback to Bern.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCslBehringJobs() — Fetch and parse all Swiss jobs
 *   - isCslBehringJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()        — Validate URLs belong to CSL / Workday tenant
 *   - CSL_BEHRING_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDescriptionText,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CSL_BEHRING_KEY = 'csl-behring';
export const CSL_BEHRING_COMPANY_NAME = 'CSL Behring';
export const CSL_BEHRING_COMPANY_DOMAIN = 'cslbehring.com';

const WORKDAY_TENANT_HOST = 'csl.wd1.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'CSL_External';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://careers.cslbehring.com/';

// Switzerland country UUID — standard across most Workday tenants.
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Tokens that obviously aren't city names in CSL's comma-delimited location string.
const NON_CITY_TOKENS = new Set([
  'emea', 'amer', 'apac', 'na', 'eu', 'us', 'usa', 'uk', 'eur',
  'ch', 'de', 'at', 'it', 'fr', 'es', 'be', 'nl', 'pt',
  'csl', 'csl behring', 'csl plasma', 'csl seqirus', 'csl vifor',
  'remote', 'home', 'switzerland', 'schweiz', 'suisse', 'svizzera',
]);

/**
 * CSL location strings look like:
 *   "EMEA, CH, Kanton Bern, Bern, CSL Behring"
 *   "EMEA, CH, Kanton Bern, Bern, CSL Behring, EMEA, CH, Wankdorf"
 *   "3 Locations"
 * Strategy: split on commas, drop region/country/canton/BU tokens, pick first
 * remaining token that the BFS matcher recognises as a Swiss municipality.
 * Falls back to last informative segment.
 */
function cleanCslLocation(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/\d+\s+location/i.test(trimmed)) return '';
  const segments = trimmed.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const candidates = segments.filter((seg) => {
    const lower = seg.toLowerCase();
    if (NON_CITY_TOKENS.has(lower)) return false;
    if (/^kanton\b/i.test(seg)) return false;
    if (/^canton\b/i.test(seg)) return false;
    return true;
  });
  if (candidates.length === 0) return '';
  // Prefer the first candidate the BFS matcher recognises.
  for (const c of candidates) {
    if (inferSwissTargetCanton(c)) return c;
  }
  return candidates[0];
}

/* ── Company matchers ──────────────────────────────────────── */

export function isCslBehringJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CSL_BEHRING_KEY ||
    key === 'cslbehring' ||
    key.startsWith('csl-behring') ||
    company.includes('csl behring') ||
    company.includes('cslbehring') ||
    url.includes('cslbehring.com') ||
    url.includes('csl.wd1.myworkdayjobs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'cslbehring.com' ||
      host.endsWith('.cslbehring.com') ||
      host === 'csl.com' ||
      host.endsWith('.csl.com') ||
      host === WORKDAY_TENANT_HOST ||
      host.endsWith('.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(regulatory|qualität|qualit|qa|qc|validation|compliance|gxp|gmp)/.test(t)) return 'Qualità / Compliance';
  if (/\b(manufactur|production|fertigung|produktion|operator|polymech|automatik|ausbildung|lehrstelle|mechanik|techniker|technician|maint|wartung|tech\s*ops)/.test(t)) return 'Tecnica';
  if (/\b(engineer|ingenieur|developer|software|programm|informatik|r&d|research|scientist|principal\s*scientist)/.test(t)) return 'Ingegneria';
  if (/\b(sales|kundenberat|account|vertrieb|representative|business\s*develop)/.test(t)) return 'Vendite';
  if (/\b(market|kommunikation|brand|product\s*manager|medical\s*affairs)/.test(t)) return 'Marketing';
  if (/\b(supply|logist|warehouse|lager|procurement|purchas|einkauf)/.test(t)) return 'Logistica';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|controlling|buchhalt|finanz|treasur)/.test(t)) return 'Finanza';
  if (/\b(legal|counsel|lawyer|attorney)/.test(t)) return 'Legale';
  if (/\b(it\b|sap|cloud|cyber|data|infrastructure|network|devops|digital)/.test(t)) return 'IT';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|intern|stage|stagiair|lehrstelle|lernende?r?|apprenti|ausbildung|trainee|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|principal|chief|manager|leiter|leitend|verantwort)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Workday fetcher ───────────────────────────────────────── */

async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      // CSL uses the standard 'locationCountry' facet.
      locationFilters: SWISS_LOCATION_IDS,
      maxPages: 10,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: CSL_BEHRING_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        locationRaw: posting.locationsText || id.location || '',
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out;
}

export async function fetchAllCslBehringJobs() {
  console.log(`🏭 Fetching ${CSL_BEHRING_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Workday: ${WORKDAY_API_BASE}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned from Workday API.');
    return [];
  }

  console.log(`  📋 Swiss listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.locationRaw || 'Bern';
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    const cleaned = cleanCslLocation(rawLocation);
    const location = cleaned || 'Bern';
    const canton = inferSwissTargetCanton(location) || 'BE';
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint never returns the body — fetch detail.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${CSL_BEHRING_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: CSL Behring — global biotech leader in plasma-derived and recombinant therapies (immunology, haematology, cardiovascular, transplant).',
      '• Swiss footprint: Bern HQ for tech-ops & manufacturing; R&D + commercial functions across CH.',
      '• Apply: CSL Behring Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${CSL_BEHRING_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${CSL_BEHRING_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CSL_BEHRING_COMPANY_NAME,
      companyKey: CSL_BEHRING_KEY,
      companyDomain: CSL_BEHRING_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, translate-pending.yml picks the job up.
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: `${CSL_BEHRING_COMPANY_NAME} Dedicated Parser (Workday)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || '', title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Biotech / Farmaceutico',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.jobReqId) job.jobReqId = listing.jobReqId;

    jobs.push(job);
  }

  console.log(`\n📋 Total ${CSL_BEHRING_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

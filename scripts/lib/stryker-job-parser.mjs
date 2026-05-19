#!/usr/bin/env node
/**
 * Stryker job parser — Workday ATS (Swiss operations).
 *
 * Tenant host: stryker.wd1.myworkdayjobs.com
 * Site path:   StrykerCareers
 * Career URL:  https://careers.stryker.com/
 *
 * Stryker is a US-headquartered medical-device multinational; its Swiss
 * operations are concentrated in canton Solothurn (Selzach R&D + Biberist
 * regulatory/manufacturing). At the time of this parser, the Workday tenant
 * exposed ~8 open Swiss positions.
 *
 * Important Workday quirk: this tenant uses the facet parameter
 * `Location_Country` (capitalised, underscore) rather than the more common
 * `locationCountry`. The Swiss facet ID is the standard Workday
 * `187134fccb084a0ea9b4b95f23890dbe`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllStrykerJobs() — Fetch and parse all Swiss jobs
 *   - isStrykerJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to Stryker / Workday tenant
 *   - STRYKER_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
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

export const STRYKER_KEY = 'stryker';
export const STRYKER_COMPANY_NAME = 'Stryker';
export const STRYKER_COMPANY_DOMAIN = 'stryker.com';

const WORKDAY_TENANT_HOST = 'stryker.wd1.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'StrykerCareers';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://careers.stryker.com/';

// Switzerland country UUID is consistent across most Workday tenants.
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company matchers ──────────────────────────────────────── */

export function isStrykerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STRYKER_KEY ||
    key.startsWith('stryker') ||
    company.includes('stryker') ||
    url.includes('stryker.com') ||
    url.includes('stryker.wd1.myworkdayjobs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'stryker.com' ||
      host.endsWith('.stryker.com') ||
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
  if (/\b(regulatory|qualität|qualit|qa|qc|validation|compliance)/.test(t)) return 'Qualità / Compliance';
  if (/\b(manufactur|production|fertigung|produktion|operator|polymech|automatik|ausbildung|lehrstelle|mechanik|techniker|technician|maint|wartung)/.test(t)) return 'Tecnica';
  if (/\b(engineer|ingenieur|developer|software|programm|informatik|r&d|research)/.test(t)) return 'Ingegneria';
  if (/\b(sales|kundenberat|account|vertrieb|representative|business\s*develop)/.test(t)) return 'Vendite';
  if (/\b(market|kommunikation|brand|product\s*manager)/.test(t)) return 'Marketing';
  if (/\b(supply|logist|warehouse|lager|procurement|purchas|einkauf)/.test(t)) return 'Logistica';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|controlling|buchhalt|finanz)/.test(t)) return 'Finanza';
  if (/\b(legal|counsel|lawyer|compliance)/.test(t)) return 'Legale';
  if (/\b(it\b|sap|cloud|cyber|data|infrastructure|network|devops)/.test(t)) return 'IT';
  return 'Tecnica';
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
      // Workday tenant uses 'Location_Country' rather than 'locationCountry'.
      appliedFacets: { Location_Country: SWISS_LOCATION_IDS },
      maxPages: 5,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: STRYKER_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        location: id.location,
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

export async function fetchAllStrykerJobs() {
  console.log(`🏭 Fetching ${STRYKER_COMPANY_NAME} jobs`);
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

    const rawLocation = listing.location || 'Selzach';
    // Skip if Workday returned a clearly-foreign location despite the country filter
    // (Workday sometimes returns "N Locations" rollups — handled by fallback to Selzach).
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    // Strip the ", Switzerland" / ", Schweiz" suffix Stryker appends to every Swiss
    // posting so the city alone hits the BFS canton matcher cleanly.
    const cleanedLocation = String(rawLocation)
      .replace(/,?\s*(switzerland|schweiz|suisse|svizzera)\s*$/i, '')
      .trim();
    const location = cleanedLocation && !/\d+\s+location/i.test(cleanedLocation) ? cleanedLocation : 'Selzach';
    const canton = inferSwissTargetCanton(location) || 'SO';
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint NEVER returns the job body — fetch detail.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${STRYKER_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: Stryker — global leader in medical technology (orthopaedics, medical & surgical, neurotechnology).',
      '• Swiss footprint: R&D + manufacturing hubs in Selzach (SO) and Biberist (SO).',
      '• Apply: Stryker Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${STRYKER_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${STRYKER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STRYKER_COMPANY_NAME,
      companyKey: STRYKER_KEY,
      companyDomain: STRYKER_COMPANY_DOMAIN,
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
      source: `${STRYKER_COMPANY_NAME} Dedicated Parser (Workday)`,
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
      sector: 'Medtech / Dispositivi medici',
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

  console.log(`\n📋 Total ${STRYKER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

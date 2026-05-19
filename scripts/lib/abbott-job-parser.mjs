#!/usr/bin/env node
/**
 * Abbott job parser — Workday ATS (Swiss operations).
 *
 * Tenant host: abbott.wd5.myworkdayjobs.com
 * Site path:   abbottcareers
 * Career URL:  https://www.jobs.abbott/
 *
 * Abbott is a US-headquartered diversified healthcare multinational
 * (medical devices, diagnostics, established pharmaceuticals, nutrition).
 * Swiss operations are concentrated in Basel/Zurich plus French-speaking
 * sales reps across Romandie (Fribourg, Vaud, Valais). At the time of this
 * parser, the Workday tenant exposed ~21 open Swiss positions.
 *
 * Workday quirk: this tenant uses the facet parameter `Location_Country`
 * (capitalised, underscore) rather than the more common `locationCountry` —
 * same as Stryker. The Swiss facet ID is the standard Workday
 * `187134fccb084a0ea9b4b95f23890dbe`.
 *
 * Location text format: `Switzerland - {Canton} - {City}` (Basel, Zurich,
 * Fribourg, Remote, …). We strip the leading "Switzerland - " then use the
 * first remaining segment as the city.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAbbottJobs() — Fetch and parse all Swiss jobs
 *   - isAbbottJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to Abbott / Workday tenant
 *   - ABBOTT_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
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

export const ABBOTT_KEY = 'abbott';
export const ABBOTT_COMPANY_NAME = 'Abbott';
export const ABBOTT_COMPANY_DOMAIN = 'abbott.com';

const WORKDAY_TENANT_HOST = 'abbott.wd5.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'abbottcareers';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://www.jobs.abbott/';

// Switzerland country UUID is consistent across most Workday tenants.
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Abbott location strings look like:
 *   "Switzerland - Basel"
 *   "Switzerland - Fribourg - Fribourg"
 *   "Switzerland - Zurich"
 *   "Switzerland - Remote"
 * Strip the leading country segment and return the most-specific remaining city.
 */
function cleanAbbottLocation(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/\d+\s+location/i.test(trimmed)) return '';
  // Strip leading "Switzerland - " (and language variants)
  const stripped = trimmed.replace(/^\s*(switzerland|schweiz|suisse|svizzera)\s*-\s*/i, '').trim();
  if (!stripped) return '';
  const parts = stripped.split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  // Last segment is usually the city (when present), else the canton/region.
  return parts[parts.length - 1] || '';
}

/* ── Company matchers ──────────────────────────────────────── */

export function isAbbottJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ABBOTT_KEY ||
    key.startsWith('abbott') ||
    company.includes('abbott') ||
    url.includes('abbott.com') ||
    url.includes('jobs.abbott') ||
    url.includes('abbott.wd5.myworkdayjobs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'abbott.com' ||
      host.endsWith('.abbott.com') ||
      host === 'jobs.abbott' ||
      host.endsWith('.jobs.abbott') ||
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
  if (/\b(regulatory|qualität|qualit|qa|qc|validation|compliance|gxp)/.test(t)) return 'Qualità / Compliance';
  if (/\b(manufactur|production|fertigung|produktion|operator|polymech|automatik|ausbildung|lehrstelle|mechanik|techniker|technician|maint|wartung|service)/.test(t)) return 'Tecnica';
  if (/\b(engineer|ingenieur|developer|software|programm|informatik|r&d|research|scientist|mechatronic)/.test(t)) return 'Ingegneria';
  if (/\b(sales|kundenberat|account|vertrieb|representative|business\s*develop|territory)/.test(t)) return 'Vendite';
  if (/\b(market|kommunikation|brand|product\s*manager|educator|medical\s*affairs)/.test(t)) return 'Marketing';
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
      // Abbott tenant uses 'Location_Country' rather than 'locationCountry'.
      appliedFacets: { Location_Country: SWISS_LOCATION_IDS },
      maxPages: 5,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: ABBOTT_COMPANY_NAME,
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

export async function fetchAllAbbottJobs() {
  console.log(`🏭 Fetching ${ABBOTT_COMPANY_NAME} jobs`);
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

    const rawLocation = listing.locationRaw || 'Basel';
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    const cleaned = cleanAbbottLocation(rawLocation);
    const location = cleaned || 'Basel';
    const canton = inferSwissTargetCanton(location) || 'BS';
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint never returns the body — fetch detail.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${ABBOTT_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: Abbott — global healthcare leader (medical devices, diagnostics, established pharmaceuticals, nutrition).',
      '• Swiss footprint: Basel HQ + sales force across Romandie & DE-CH.',
      '• Apply: Abbott Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${ABBOTT_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${ABBOTT_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ABBOTT_COMPANY_NAME,
      companyKey: ABBOTT_KEY,
      companyDomain: ABBOTT_COMPANY_DOMAIN,
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
      source: `${ABBOTT_COMPANY_NAME} Dedicated Parser (Workday)`,
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
      sector: 'Sanità / Dispositivi medici / Farmaceutico',
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

  console.log(`\n📋 Total ${ABBOTT_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

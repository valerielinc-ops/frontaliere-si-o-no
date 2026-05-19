#!/usr/bin/env node
/**
 * Medtronic job parser — Workday ATS (Swiss operations).
 *
 * Tenant host: medtronic.wd1.myworkdayjobs.com
 * Site path:   MedtronicCareers
 * Career URL:  https://jobs.medtronic.com/
 *
 * Medtronic is a global medtech leader (cardiac & vascular, medical-surgical,
 * neuroscience, diabetes). Swiss operations are concentrated in canton Vaud
 * (Tolochenaz manufacturing & Lausanne EMEA hub). At the time of this parser,
 * the Workday tenant exposed ~7 open Swiss positions.
 *
 * Workday quirk: this tenant uses the standard `locationCountry` facet with
 * the canonical Swiss UUID `187134fccb084a0ea9b4b95f23890dbe`.
 *
 * Location text format: `Lausanne, Vaud, Switzerland` (city, canton, country)
 * — we split on commas and use the first segment as the city. Also handles
 * "N Locations" rollups via fallback to Tolochenaz (VD).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMedtronicJobs() — Fetch and parse all Swiss jobs
 *   - isMedtronicJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to Medtronic / Workday tenant
 *   - MEDTRONIC_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
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

export const MEDTRONIC_KEY = 'medtronic';
export const MEDTRONIC_COMPANY_NAME = 'Medtronic';
export const MEDTRONIC_COMPANY_DOMAIN = 'medtronic.com';

const WORKDAY_TENANT_HOST = 'medtronic.wd1.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'MedtronicCareers';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://jobs.medtronic.com/';

// Switzerland country UUID — standard across most Workday tenants.
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Medtronic location strings look like:
 *   "Lausanne, Vaud, Switzerland"
 *   "Tolochenaz, Vaud, Switzerland"
 *   "2 Locations"
 * Take the first comma-segment as the city; drop the trailing country/canton.
 */
function cleanMedtronicLocation(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/\d+\s+location/i.test(trimmed)) return '';
  const parts = trimmed.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  return parts[0];
}

/* ── Company matchers ──────────────────────────────────────── */

export function isMedtronicJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MEDTRONIC_KEY ||
    key.startsWith('medtronic') ||
    company.includes('medtronic') ||
    url.includes('medtronic.com') ||
    url.includes('jobs.medtronic.com') ||
    url.includes('medtronic.wd1.myworkdayjobs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'medtronic.com' ||
      host.endsWith('.medtronic.com') ||
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
  if (/\b(manufactur|production|fertigung|produktion|operator|polymech|automatik|ausbildung|lehrstelle|mechanik|techniker|technician|maint|wartung)/.test(t)) return 'Tecnica';
  if (/\b(engineer|ingenieur|developer|software|programm|informatik|r&d|research|scientist)/.test(t)) return 'Ingegneria';
  if (/\b(sales|kundenberat|account|vertrieb|representative|business\s*develop|territory)/.test(t)) return 'Vendite';
  if (/\b(market|kommunikation|brand|product\s*manager|medical\s*affairs)/.test(t)) return 'Marketing';
  if (/\b(supply|logist|warehouse|lager|procurement|purchas|einkauf)/.test(t)) return 'Logistica';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|controlling|buchhalt|finanz|treasur|business\s*analyst)/.test(t)) return 'Finanza';
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
      locationFilters: SWISS_LOCATION_IDS,
      maxPages: 3,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: MEDTRONIC_COMPANY_NAME,
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

export async function fetchAllMedtronicJobs() {
  console.log(`🏭 Fetching ${MEDTRONIC_COMPANY_NAME} jobs`);
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

    const rawLocation = listing.locationRaw || 'Tolochenaz';
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    const cleaned = cleanMedtronicLocation(rawLocation);
    const location = cleaned || 'Tolochenaz';
    const canton = inferSwissTargetCanton(location) || 'VD';
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint never returns the body — fetch detail.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${MEDTRONIC_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: Medtronic — global medical technology leader (cardiac & vascular, medical-surgical, neuroscience, diabetes).',
      '• Swiss footprint: Tolochenaz (VD) manufacturing & Lausanne EMEA hub.',
      '• Apply: Medtronic Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${MEDTRONIC_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${MEDTRONIC_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MEDTRONIC_COMPANY_NAME,
      companyKey: MEDTRONIC_KEY,
      companyDomain: MEDTRONIC_COMPANY_DOMAIN,
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
      source: `${MEDTRONIC_COMPANY_NAME} Dedicated Parser (Workday)`,
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

  console.log(`\n📋 Total ${MEDTRONIC_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

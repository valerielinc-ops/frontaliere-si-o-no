#!/usr/bin/env node
/**
 * Alcon job parser — Workday ATS (Swiss operations).
 *
 * Tenant host: alcon.wd5.myworkdayjobs.com
 * Site path:   careers_alcon
 * Career URL:  https://www.alcon.com/careers
 *
 * Alcon is the global leader in eye care (surgical equipment, intraocular
 * lenses, contact lenses, ocular pharmaceuticals). Headquartered in Geneva
 * with major Swiss operations in Fribourg (Schönbühl manufacturing) and
 * Schaffhausen. At the time of this parser, the Workday tenant exposed
 * ~5 open Swiss positions (small but consistent flow).
 *
 * Workday quirk: this tenant uses the standard `locationCountry` facet with
 * the canonical Swiss UUID `187134fccb084a0ea9b4b95f23890dbe`.
 *
 * Location text format: `Fribourg - ASSA` (Alcon Swiss Standard Address —
 * a Schönbühl manufacturing complex), `Fribourg, Switzerland`, or rollups
 * like `2 Locations`. We split on " - " / "," and pick the first city-like
 * segment; fall back to Fribourg.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAlconJobs() — Fetch and parse all Swiss jobs
 *   - isAlconJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to Alcon / Workday tenant
 *   - ALCON_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
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

export const ALCON_KEY = 'alcon';
export const ALCON_COMPANY_NAME = 'Alcon';
export const ALCON_COMPANY_DOMAIN = 'alcon.com';

const WORKDAY_TENANT_HOST = 'alcon.wd5.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'careers_alcon';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://www.alcon.com/careers';

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
 * Alcon location strings look like:
 *   "Fribourg - ASSA"        ← ASSA = Alcon Schönbühl manufacturing
 *   "Fribourg, Switzerland"
 *   "2 Locations"
 * Split on either " - " or ",". Drop the trailing country / internal site
 * code (`ASSA`) and return the first segment that the BFS matcher likes,
 * or the first segment otherwise.
 */
function cleanAlconLocation(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/\d+\s+location/i.test(trimmed)) return '';
  // Strip "Switzerland" suffix
  const noSuffix = trimmed.replace(/,?\s*(switzerland|schweiz|suisse|svizzera)\s*$/i, '').trim();
  // Split on either " - " or ","
  const parts = noSuffix.split(/\s*[-,]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  // Prefer the first part the BFS matcher recognises as a Swiss municipality.
  for (const p of parts) {
    if (inferSwissTargetCanton(p)) return p;
  }
  return parts[0];
}

/* ── Company matchers ──────────────────────────────────────── */

export function isAlconJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ALCON_KEY ||
    key.startsWith('alcon') ||
    company.includes('alcon') ||
    url.includes('alcon.com') ||
    url.includes('alcon.wd5.myworkdayjobs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'alcon.com' ||
      host.endsWith('.alcon.com') ||
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
  if (/\b(sales|kundenberat|account|vertriebsmitarbeiter|vertrieb|representative|business\s*develop|territory|aussendienst)/.test(t)) return 'Vendite';
  if (/\b(market|kommunikation|brand|product\s*manager|medical\s*affairs|consumer)/.test(t)) return 'Marketing';
  if (/\b(supply|logist|warehouse|lager|procurement|purchas|einkauf|sourcing)/.test(t)) return 'Logistica';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|controlling|buchhalt|finanz|treasur|reporting)/.test(t)) return 'Finanza';
  if (/\b(legal|counsel|lawyer|attorney)/.test(t)) return 'Legale';
  if (/\b(it\b|sap|cloud|cyber|data|infrastructure|network|devops|digital|analytics)/.test(t)) return 'IT';
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
        company: ALCON_COMPANY_NAME,
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

export async function fetchAllAlconJobs() {
  console.log(`🏭 Fetching ${ALCON_COMPANY_NAME} jobs`);
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

    const rawLocation = listing.locationRaw || 'Fribourg';
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    const cleaned = cleanAlconLocation(rawLocation);
    const location = cleaned || 'Fribourg';
    const canton = inferSwissTargetCanton(location) || 'FR';
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint never returns the body — fetch detail.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${ALCON_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: Alcon — global leader in eye care (surgical equipment, intraocular lenses, contact lenses, ocular pharmaceuticals).',
      '• Swiss footprint: Geneva HQ + Fribourg/Schönbühl (ASSA) manufacturing + Schaffhausen R&D.',
      '• Apply: Alcon Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${ALCON_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${ALCON_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ALCON_COMPANY_NAME,
      companyKey: ALCON_KEY,
      companyDomain: ALCON_COMPANY_DOMAIN,
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
      source: `${ALCON_COMPANY_NAME} Dedicated Parser (Workday)`,
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
      sector: 'Medtech / Cura della vista',
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

  console.log(`\n📋 Total ${ALCON_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

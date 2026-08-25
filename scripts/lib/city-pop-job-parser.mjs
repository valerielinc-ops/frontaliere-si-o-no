#!/usr/bin/env node
/**
 * City Pop AG job parser — jobs.ch public search API + JSON-LD detail.
 *
 * Source: https://www.jobs.ch/en/companies/eb0155fc-e81e-4f2c-8770-e211d2689811-city-pop-ag/
 * (public company profile page; the jobs.ch API discovery below is what
 * actually feeds this parser — see ./jobs-ch-search-common.mjs)
 *
 * @outsourced-ats-needs-verification: citypop.com returns HTTP 403 to
 * automated fetches (bot protection), so whether City Pop publishes its own
 * direct listing page could not be checked live on 2026-08-25. Needs a real
 * browser (or an agent with one) to confirm before this can be marked
 * confirmed or needs-migration.
 *
 * City Pop is a Swiss "micro-living" / serviced-apartment scale-up (fully
 * furnished flexible-stay apartments) founded in Ticino, now operating in
 * Zürich, Lugano, Lausanne, Bern, Geneva, Baden and expanding into Germany,
 * Italy and Poland. Confirmed GENUINE DIRECT EMPLOYER, not a staffing or
 * placement agency:
 *   - Registered in the Swiss commercial register as "City Pop AG"
 *     (CHE-325.832.314, Zefix), with an active Ticino branch
 *     "City Pop AG, succursale di Manno" (CHE-479.731.100) — confirming the
 *     company's continued Ticino presence even though the legal seat moved
 *     to Zürich in 2021.
 *   - jobs.ch company profile (`webPageUrl`) points directly at
 *     https://citypop.com/, its own corporate site, and the profile
 *     "portraitDescription" is first-person marketing copy about the
 *     company itself, not a client-mandate agency blurb.
 *
 * jobs.ch company profile id (UUID-form, not a legacy numeric id):
 *   eb0155fc-e81e-4f2c-8770-e211d2689811
 * Confirmed live via the public, unauthenticated jobs.ch search API
 * (`job-search-api.jobs.ch/search?companyIds=...`) — as of the initial
 * build (2026-07) the company has 0 open postings (`totalHits: 0`), but the
 * feed itself is live and will surface new roles automatically as City Pop
 * posts them (fast-growing scale-up, multiple Swiss cities).
 *
 * HQ fallback address (confirmed via Zefix commercial-register extract,
 * CHE-325.832.314): Bernerstrasse Süd 169, 8048 Zürich, ZH.
 *
 * Exports the 3 functions used by the crawler template:
 *   - fetchAllCityPopJobs() — Fetch and parse all Swiss jobs
 *   - isCityPopJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { detectEmploymentTypeFromOccupation } from './jobup-ch-feed-common.mjs';
import {
  fetchJobsChCompanyListings,
  fetchJobsChJobPostingLd,
  jobsChDetailUrl,
} from './jobs-ch-search-common.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CITY_POP_KEY = 'city-pop';
export const CITY_POP_COMPANY_NAME = 'City Pop';
export const CITY_POP_COMPANY_DOMAIN = 'citypop.com';

const COMPANY_IDS = ['eb0155fc-e81e-4f2c-8770-e211d2689811'];
const CAREER_URL =
  'https://www.jobs.ch/en/companies/eb0155fc-e81e-4f2c-8770-e211d2689811-city-pop-ag/';

/* HQ fallback: Bernerstrasse Süd 169, 8048 Zürich (Zefix, CHE-325.832.314). */
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8048',
  streetAddress: 'Bernerstrasse Süd 169',
};

const SECTOR = 'Immobiliare / Micro-living / Ospitalità';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isCityPopJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CITY_POP_KEY ||
    key.startsWith('city-pop') ||
    company.includes('city pop') ||
    url.includes('citypop.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'citypop.com' || host.endsWith('.citypop.com')) return true;
    if (host === 'jobs.ch' || host.endsWith('.jobs.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(reception|réception|empfang|guest|ospiti|front.?desk|concierge)/.test(t)) return 'Ospitalità';
  if (/\b(immobil|property|liegenschaft|immeuble|facility)/.test(t)) return 'Immobiliare';
  if (/\b(vendita|sales|verkauf|commerc|acquisiz)/.test(t)) return 'Commerciale';
  if (/\b(marketing|comunicaz|communication|kommunikation)/.test(t)) return 'Marketing';
  if (/\b(it|software|develop|programm|tech)/.test(t)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|finance|finanz|controll)/.test(t)) return 'Amministrazione';
  if (/\b(manuten|wartung|maintenance|entretien|hauswart|janitor)/.test(t)) return 'Manutenzione';
  if (/\b(operations|operativ|betrieb|exploitation)/.test(t)) return 'Operations';
  if (/\b(hr|human|risorse|personal|ressources)/.test(t)) return 'Risorse Umane';
  if (/\b(project|projekt|progett)/.test(t)) return 'Project Management';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map jobs.ch's free-text `employmentType` (JSON-LD) + posting workload
 * grades to the schema.org employmentType enum consumed downstream.
 * Confirmed values used across other jobs.ch-fed crawlers: "Permanent
 * position", "Internship", "Temporary", "Supplementary income".
 */
function resolveEmploymentType(ldEmploymentType = '', grades = []) {
  const t = normalize(ldEmploymentType);
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ]))/.test(t)) return 'INTERN';
  if (/temporary|fixed.term|contract/.test(t)) return 'TEMPORARY';
  if (/supplementary/.test(t)) return 'PER_DIEM';
  const nums = (Array.isArray(grades) ? grades : []).map(Number).filter(Number.isFinite);
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 100;
  return detectEmploymentTypeFromOccupation(min, max) === 'PART_TIME' ? 'PART_TIME' : 'FULL_TIME';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all City Pop jobs. Returns an array of ParsedJob objects
 * (source-locale only — other locales are filled by the AI localization
 * step and translate-pending pipeline).
 */
export async function fetchAllCityPopJobs() {
  console.log(`🔍 Fetching ${CITY_POP_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobsChCompanyListings({ companyIds: COMPANY_IDS });
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  const seenSlugs = new Set();

  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);

    let ld = null;
    let detailUrl = jobsChDetailUrl(listing.id, 'en');
    try {
      const detail = await fetchJobsChJobPostingLd(listing.id, { locale: 'en' });
      ld = detail.ld;
      detailUrl = detail.url;
    } catch (err) {
      console.warn(`⚠️ Failed to fetch detail for ${listing.id}: ${err?.message || err}`);
    }

    const loc0 = Array.isArray(listing.locations) ? listing.locations[0] : null;
    const place = normalizeSpace(listing.place || loc0?.city || '');
    const canton =
      normalizeCantonCode(loc0?.cantonCode || '') ||
      inferAnyCanton(place) ||
      HQ.canton;

    const descriptionHtml = ld?.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} presso ${CITY_POP_COMPANY_NAME} a ${place || HQ.city}.`;
    // No hardcoded language fallback: City Pop operates across German-,
    // French- and Italian-speaking Switzerland (Zürich/Baden AND Lugano/
    // Lausanne/Geneva) — a single-locale default would silently mistag an
    // ambiguous FR/IT posting as 'de', freezing the wrong locale key in
    // slugByLocale/descriptionByLocale downstream. `null` on a genuinely
    // ambiguous/short text is handled gracefully: mergeLocaleTextMap()
    // treats a falsy sourceLocale as "unknown" (symmetric merge, no forced
    // locale overwrite) and hardenJobLocaleFields() re-derives + backfills
    // the real source locale from the job's own title/description on the
    // very next pipeline step.
    const sourceLang = detectLang(descriptionText || title, null);

    const urlHash = createHash('sha1').update(listing.id).digest('hex').slice(0, 12);

    // Two distinct postings can legitimately share title+location (e.g.
    // City Pop opening 2 identical headcount slots at the same site) —
    // disambiguate in-run collisions with a short id suffix so both jobs
    // keep a stable, unique slug instead of silently colliding.
    let jobSlug = slugify(`${title} city pop ${place || HQ.city}`);
    if (seenSlugs.has(jobSlug)) {
      jobSlug = slugify(`${title} city pop ${place || HQ.city} ${urlHash.slice(0, 6)}`);
    }
    seenSlugs.add(jobSlug);

    const employmentType = resolveEmploymentType(ld?.employmentType || '', listing.employmentGrades);
    const postedDate = (listing.publicationDate && String(listing.publicationDate).slice(0, 10))
      || (listing.initialPublicationDate && String(listing.initialPublicationDate).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const hiringOrganizationName = ld?.hiringOrganization?.name || listing.company?.name || CITY_POP_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${CITY_POP_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CITY_POP_COMPANY_NAME,
      companyKey: CITY_POP_KEY,
      companyDomain: CITY_POP_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: place || HQ.city,
      canton,
      url: detailUrl,
      source: 'City Pop Dedicated Parser (jobs.ch)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: loc0?.city || place || HQ.city,
      addressRegion: canton,
      streetAddress: normalizeSpace(loc0?.street || '') || (canton === HQ.canton ? HQ.streetAddress : ''),
      postalCode: normalizeSpace(loc0?.postalCode || '') || (canton === HQ.canton ? HQ.postalCode : ''),
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
      applyUrl: detailUrl,
      hiringOrganizationName,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${CITY_POP_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

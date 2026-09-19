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
 * the first segment that looks like a city. Multi-location postings collapse
 * to `N Locations` in the listing, so the detail payload's primary location is
 * inspected before publication. An additional location does not override a
 * foreign primary workplace.
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
  fetchWorkdayJobDetail,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
  workdayPrimaryLocationState,
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

function locationDescriptor(value) {
  if (typeof value === 'string') return value;
  return [
    value?.descriptor,
    value?.location,
    value?.name,
    value?.country?.descriptor,
    value?.country?.name,
    value?.country?.alpha2Code,
    value?.country?.code,
  ].filter(Boolean).join(', ');
}

/**
 * Resolve the first Swiss city from a Workday primary/additional location
 * list. A listing's `N Locations` label is not a city and the primary detail
 * location may be a foreign tenant HQ while an additional location names the
 * Swiss workplace (for example, `EMEA, CH, Glattbrugg, CSL Behring`).
 */
export function resolveCslLocation(primaryLocation = '', additionalLocations = []) {
  const candidates = [
    primaryLocation,
    ...(Array.isArray(additionalLocations) ? additionalLocations : []),
  ];
  for (const candidate of candidates) {
    const cleaned = cleanCslLocation(locationDescriptor(candidate));
    if (cleaned && inferSwissTargetCanton(cleaned)) return cleaned;
  }
  return '';
}

/**
 * The Swiss city a req may be PUBLISHED under, or `''`.
 *
 * `resolveCslLocation` above answers a different question — «is any location
 * on this req Swiss, and which» — over `[primary, ...additionalLocations]`,
 * and its cases pin that union deliberately. It is the wrong question for the
 * publish decision, because a req worked in King of Prussia that also lists
 * Glattbrugg resolves to Glattbrugg and goes out as a Swiss vacancy.
 *
 * Only the req's own primary location licenses the stamp. Kept as its own
 * exported predicate so the call site cannot drift back to the union without
 * breaking a test that names this rule.
 */
export function resolveCslPublishLocation(info = {}) {
  return resolveCslLocation(info?.location, []);
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
  if (/\b(praktik|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|lehrstelle|lernende?r?|apprenti|ausbildung|trainee|graduate)/.test(t)) return 'intern';
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
      maxPages: 100000,
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

    // The listing endpoint frequently returns only `N Locations`. Fetch the
    // detail once, then require its authoritative primary location to be Swiss.
    const detail = await fetchWorkdayJobDetail(WORKDAY_API_BASE, listing.externalPath);
    const info = detail?.jobPostingInfo || {};
    const detailLocations = [
      info.location,
      ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : []),
    ].map(locationDescriptor).filter(Boolean);
    // The Swiss city that licenses publication has to come from the req's OWN
    // primary location. Resolving it over [primary, ...additionalLocations]
    // published a foreign vacancy under whichever Swiss site happened to be
    // listed alongside it: measured on data/jobs/by-crawler/csl-behring.json,
    // 12 of 25 records carried a non-Swiss primary location in their own
    // Workday path and went out as Swiss cities anyway — 8 King-of-Prussia (US-PA)
    // as Glattbrugg/Opfikon/Bern, 2 Waltham (US-MA) and 3 Maidenhead (GB) as
    // Glattbrugg (the Maidenhead group overlaps the count by one record whose
    // path is Berkshire-Maidenhead). Every one of the 13 correctly-published
    // records has a `EMEA-CH-*` primary, so the primary is the reliable field
    // here and the docblock's premise — a foreign primary standing in for a
    // Swiss workplace named only among the additional locations — is not
    // exhibited by a single record in the slice.
    const resolvedDetailLocation = resolveCslPublishLocation(info);
    const detailLocationText = detailLocations.join(' | ');
    if (!resolvedDetailLocation && isLocationExplicitlyForeign(detailLocationText)) {
      console.log(`  ⏭️  Skipped foreign location: ${detailLocationText} — ${title}`);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    // Fail closed instead of defaulting to Bern. `|| 'Bern'` here and
    // `|| 'Bern'` / `|| 'BE'` below were the generic-city fallback
    // audit-parser-quality.mjs names in its ACTION line, and one US-PA req in
    // the slice is published as `Bern` purely through it.
    // The listing row may stand in for the primary only when the detail has NO
    // primary at all. `resolveCslPublishLocation` returns '' both when the field
    // is absent and when it is present but unrecognised, and `resolved ||
    // listing.locationRaw` turned the second case into the first — so a Swiss
    // listing row could publish an unknown or foreign primary under a Swiss
    // city and canton. That is fail-open, and it is the same semantic error as
    // a canton resolver that never fails: the resolver is right, the caller
    // misreads its empty answer.
    const primaryState = workdayPrimaryLocationState(info);
    const rawLocation = resolvedDetailLocation
      || (primaryState.present ? '' : (listing.locationRaw || ''));
    if (!rawLocation || isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped (no Swiss primary location): ${detailLocationText || rawLocation} — ${title}`);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const cleaned = cleanCslLocation(rawLocation);
    const canton = cleaned ? inferSwissTargetCanton(cleaned) : '';
    if (!cleaned || !canton) {
      console.log(`  ⏭️  Skipped (Swiss canton not resolvable from "${rawLocation}"): ${title}`);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const location = cleaned;
    const publicUrl = listing.url || CAREER_URL;
    const employmentType = detectEmploymentType(listing.timeType || '', title);

    // Workday listing endpoint never returns the body; reuse the detail
    // response already fetched for the authoritative location fields.
    const detailDescription = info.jobDescription
      ? stripHtml(String(info.jobDescription))
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 4000)
      : '';
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
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
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

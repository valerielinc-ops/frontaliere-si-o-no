#!/usr/bin/env node
/**
 * Valora Group job parser — first-party API-backed career portal.
 *
 * Source: https://career.valora.com/en/ (the canonical career portal;
 * https://www.valora.com/en/career/ links here; https://jobs.valora.com/
 * does NOT resolve — DNS NXDOMAIN, confirmed via curl).
 *
 * Valora Group is a Swiss "foodvenience" retailer (~15,000 employees,
 * ~2,800 points of sale across Switzerland/Germany/Austria/Luxembourg/
 * Netherlands) operating brands k kiosk, Brezelkönig, Press & Books,
 * avec, Caffè Spettacolo, BackWerk, Ditsch, own-brand ok.–, plus fintech
 * unit "bob Finance". Headquartered in Muttenz, Basel-Landschaft
 * (Hofackerstrasse 40, 4132 Muttenz BL) — confirmed via Valora's own
 * Impressum (https://www.valora.com/de/imprint/: "Hofackerstrasse 40,
 * 4132 Muttenz, Schweiz"), cross-checked against Zefix/Moneyhouse
 * Handelsregister entries for Valora Holding AG / Valora Schweiz AG
 * (CHE-103.468.185, Muttenz).
 *
 * The portal's current Next.js HTML is only an application shell. Its own
 * `/api/jobs` endpoint is the authoritative Switzerland-filtered feed and
 * carries the full description, location, publication date, and application
 * URL for each posting; the parser validates that envelope before publishing.
 *
 * Listing API: https://career.valora.com/api/jobs?criteria[jobCountry][0]=1
 * &limit=100&page=N&locale=de. The explicit totalCount/totalPages metadata
 * makes a partial response distinguishable from a legitimate empty source.
 *
 * Detail pages (https://career.valora.com/en/job/{id}/{slug}) expose a
 * labelled param strip (`uk-tooltip="Reference number|Field of
 * Activity|Career Level|Employment Type|Job location|Publication date"`)
 * plus a description body (`.ct-jobs-detail-text`, plain UTF-8, no HTML
 * entity escaping) and — for jobs tied to a physical site — a sidebar
 * address block (`<h3 class="uk-heading-medium">{brand}</h3>
 * <p>{street}, {postalCode} {city}, {region}, {country}</p>`). Some
 * postings (e.g. "Agenturpartner" insurance/lottery agency-partner
 * roles spanning a whole canton/region, such as job 5800 "Agenturpartner
 * Kanton Basel-Stadt/Baselland") carry only a short city tag and NO
 * address block — those fall back through resolveAddress() below, which
 * is gated on the job's own resolved CITY TEXT matching Muttenz via
 * regex, never on canton equality alone (see resolveAddress()
 * docstring — a Liestal or Pratteln job is BL-canton too but isn't
 * Muttenz, so it must not receive the Muttenz street address).
 *
 * Exports 4 functions the crawler template expects:
 * - fetchAllValoraJobs() — Fetch + parse all Swiss jobs
 * - isValoraJob() — Match jobs belonging to this company
 * - isTrustedDomain() — Validate URLs belong to this company
 * - VALORA_KEY / VALORA_COMPANY_NAME / VALORA_COMPANY_DOMAIN constants
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VALORA_KEY = 'valora';
export const VALORA_COMPANY_NAME = 'Valora Group';
export const VALORA_COMPANY_DOMAIN = 'valora.com';

const CAREER_URL = 'https://career.valora.com/en/';
export const VALORA_API_URL = 'https://career.valora.com/api/jobs';
const API_PAGE_LIMIT = 100;
const MAX_PAGES = 15; // safety cap for an unexpectedly large API response

const SECTOR = 'Retail / Foodvenience';

// cloudtec-hosted portal serves a normal page to a real browser UA; no
// anti-bot challenge observed, but a browser UA is used defensively
// (same precaution taken by Deloitte's Avature parser for its ATS).
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ── HQ fallback (Hofackerstrasse 40, 4132 Muttenz, BL) ──────── */
/* Confirmed via Valora's own Impressum + Zefix/Moneyhouse Handelsregister
 * — not a guess. */

const HQ = {
  city: 'Muttenz',
  canton: 'BL',
  postalCode: '4132',
  streetAddress: 'Hofackerstrasse 40',
  region: 'Baselland',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Collapses accidental immediate word duplication seen live in some
// Valora address strings (e.g. detail page for job 6031 renders
// "4132 Muttenz Muttenz" — a career.valora.com data-quality artifact,
// not a parsing bug here).
function dedupeAdjacentWords(s = '') {
  return normalizeSpace(s).replace(/\b(\S+)(\s+\1\b)+/gi, '$1');
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if job belongs to Valora Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isValoraJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VALORA_KEY ||
    key.startsWith('valora') ||
    company.includes('valora') ||
    url.includes('valora.com') ||
    url.includes('career.valora.com')
  );
}

/**
 * Validate a URL belongs to Valora's own domain (the only host this
 * bespoke career portal is served from).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'valora.com' || host.endsWith('.valora.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ──────────────────────────────────────── */

function detectCategory(title = '', fieldOfActivity = '') {
  const t = normalize(`${fieldOfActivity} ${title}`);
  if (/\b(verkauf|sales|vendita|vente|kiosk|thek|barista|caffe|shop|store)/.test(t)) return 'Vendita';
  if (/\b(logist|magazz|lager|warehouse|supply chain)/.test(t)) return 'Logistica';
  if (/\b(it\b|software|develop|programm|servicenow|sap|digital)/.test(t)) return 'IT';
  if (/\b(hr\b|human|risorse umane|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finan|tax|steuer|account|buchhalt|contab|consumer finance)/.test(t)) return 'Finanza';
  if (/\b(admin|segret|assistant|assistent)/.test(t)) return 'Amministrazione';
  if (/\b(facility|immobil|betreiber)/.test(t)) return 'Facility Management';
  if (/\b(restaurant|gastro|produz|bäcker|backwerk|kitchen)/.test(t)) return 'Produzione';
  if (/\b(category|einkauf|procurement)/.test(t)) return 'Acquisti';
  return 'Altro';
}

function detectExperienceLevel(careerLevel = '', title = '') {
  const level = normalize(careerLevel);
  if (/entry|graduate|junior|einsteiger/.test(level)) return 'junior';
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprentice|trainee|lehrling|lernend)/.test(level)) return 'intern';
  if (/senior|lead|head|director|manager|geschäftsführ/.test(level)) return 'senior';

  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|leiter|geschäftsführ)/.test(t)) return 'senior';
  return 'mid';
}

// Valora's own facet has 4 values: "Full Time", "Part Time",
// "Full or Part Time", "Other" — the ambiguous "Full or Part Time"
// (and anything unrecognized) maps to OTHER rather than guessing.
function detectEmploymentType(raw = '') {
  const t = normalize(raw);
  if (/full.*part|part.*full/.test(t)) return 'OTHER';
  if (/part/.test(t)) return 'PART_TIME';
  if (/full/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

export function parseValoraDate(raw = '') {
  const value = String(raw || '').trim();
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
  if (iso) return iso[1];
  const m = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function nonPlaceholder(value = '') {
  const normalized = normalizeSpace(value);
  return normalized === '-' ? '' : normalized;
}

function normalizeApplyUrl(rawUrl = '', publicUrl = '') {
  const candidate = normalizeSpace(rawUrl);
  if (!candidate || candidate === '-') return publicUrl;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : publicUrl;
  } catch {
    return publicUrl;
  }
}

export function buildValoraApiListing(record = {}) {
  if (!record || typeof record !== 'object') {
    throw new Error('Valora API returned a non-object job record');
  }
  const id = normalizeSpace(record.externalId);
  const title = normalizeSpace(record.jobTitle);
  if (!id || !title) {
    throw new Error('Valora API job record is missing externalId or jobTitle');
  }
  const publicUrl = `${CAREER_URL}job/${encodeURIComponent(id)}/${slugify(title)}`;
  const labels = record.labels && typeof record.labels === 'object' ? record.labels : {};
  const city = nonPlaceholder(record.jobCity);
  const region = nonPlaceholder(record.jobRegion);
  const descriptionHtml = String(record.jobDescription || '');
  if (!meetsSourceBodyFloor(stripHtml(descriptionHtml))) {
    throw new Error(`Valora API job ${id} has a source description below the 50-word floor`);
  }

  return {
    id,
    url: publicUrl,
    detail: {
      title,
      shortLocation: city || region,
      publicationDateRaw: record.publicationDate || '',
      referenceNumber: id,
      fieldOfActivity: labels.category || record.jobCategory || '',
      careerLevel: labels.entryLevel || record.entryLevel || '',
      employmentLabel: labels.employmentType || record.employmentType || '',
      addrCity: city,
      addrPostal: nonPlaceholder(record.jobZipCode),
      addrStreet: nonPlaceholder(record.jobStreet),
      addrRegion: region,
      descriptionHtml,
      applyUrl: normalizeApplyUrl(record.applyUrl, publicUrl),
    },
  };
}

/**
 * Validate and normalize one first-party Valora API response.
 *
 * The response envelope is part of the source contract: accepting a bare
 * array, a missing total, or a malformed row would turn an API/schema drift
 * into a destructive empty/partial snapshot.
 */
export function parseValoraApiResponse(body = '') {
  let payload = body;
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new Error(`Valora API returned invalid JSON: ${error?.message || error}`);
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Valora API response is not an object envelope');
  }
  if (!Array.isArray(payload.jobs)) throw new Error('Valora API response is missing jobs[]');
  const totalCount = Number(payload.totalCount);
  const page = Number(payload.page);
  const totalPages = Number(payload.totalPages);
  if (!Number.isInteger(totalCount) || totalCount < 0
    || !Number.isInteger(page) || page < 1
    || !Number.isInteger(totalPages)
    || totalPages < (totalCount === 0 ? 0 : 1)) {
    throw new Error('Valora API response has invalid pagination metadata');
  }
  if (payload.jobs.length > API_PAGE_LIMIT || payload.jobs.length > totalCount) {
    throw new Error('Valora API response has an invalid jobs page size');
  }
  return {
    listings: payload.jobs.map(buildValoraApiListing),
    totalCount,
    page,
    totalPages,
  };
}

/* ── Address Resolution ─────────────────────────────────────────
 * Pick the best city / postal code / street / region for a job.
 *
 * Detail pages that describe a physical site carry a full sidebar
 * address block; postings that don't (e.g. canton-wide "Agenturpartner"
 * agency-partner roles) carry only a short city tag and no address
 * block at all. HQ street/postal is backfilled ONLY when the job's own
 * resolved CITY TEXT matches Muttenz via regex — never on canton
 * equality alone (a Liestal or Pratteln job is BL-canton too but isn't
 * Muttenz-city, so it must not receive the Muttenz street address).
 */
export function resolveAddress(rawLoc = {}) {
  const city = dedupeAdjacentWords(rawLoc.city || rawLoc.shortLocation || '');
  const postalCode = (rawLoc.postalCode || '').trim();
  const streetAddress = (rawLoc.streetAddress || '').trim();
  const region = (rawLoc.region || '').trim();

  return {
    city: city || HQ.city,
    postalCode: postalCode || (!city || /muttenz/i.test(city) ? HQ.postalCode : ''),
    streetAddress: streetAddress || (!city || /muttenz/i.test(city) ? HQ.streetAddress : ''),
    region,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

// Pulls the value out of one `uk-tooltip="<label>"` param chip, e.g.
// `uk-tooltip="Job location"><i class="fa fa-fw fa-location-dot"></i>Zürich</div>`.
function extractTooltipField(html, label) {
  const re = new RegExp(
    `uk-tooltip="${label}"[^>]*>(?:\\s*<i[^>]*>\\s*<\\/i>)?\\s*([^<]*)<\\/div>`,
    'i',
  );
  const m = html.match(re);
  return m ? normalizeSpace(m[1]) : '';
}

// Parses one listing page for `/en/job/{id}/{slug}` stub links, deduped
// by numeric job id (each listing page repeats a "Read more" link per
// card, so the same id can appear more than once per page).
function parseListingPage(html) {
  const stubs = [];
  const linkRe = /href="(\/en\/job\/(\d+)\/[^"]+)"/g;
  const seenIds = new Set();
  let m;
  while ((m = linkRe.exec(html))) {
    const [, path, id] = m;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    stubs.push({ id, url: new URL(path, CAREER_URL).toString() });
  }
  return stubs;
}

// Sections of the agency-partner template that carry the role, in page order:
// Summary (prose), Tasks and Requirements (two headed lists), Success profile
// (a list of traits) and Benefits (one `<strong>` per benefit card). The
// "Agency model" hero between them is a heading plus an external link.
const AGENCY_TEMPLATE_SECTIONS = [
  'ct-jobs-detail-nutshell',
  'ct-jobs-detail-requirements',
  'ct-jobs-detail-successprofile',
  'ct-jobs-detail-benefits',
];

/**
 * The role body of an "Agenturpartner" posting.
 *
 * This template has no `.ct-jobs-detail-text` block. The parser used to keep
 * only the prose column of its Summary section, so the published ad lost the
 * tasks, the requirements (equity capital, permit), the success profile and
 * the benefits — 1,255 of the 5,004 characters of
 * `/en/job/229/agenturpartnerin-agenturpartner-kanton-graubunden`
 * (measured 2026-09-29).
 *
 * Attributes are dropped before anything else: the wrappers carry
 * `uk-scrollspy="target: > *; ..."`, whose literal `>` breaks the simple
 * `<[^>]+>` tag stripper mid-attribute. Images, the chart canvas and icons go
 * with them; each benefit card's `<strong>` becomes a list item.
 */
export function extractAgencyTemplateHtml(html = '') {
  const parts = [];
  for (const cls of AGENCY_TEMPLATE_SECTIONS) {
    const match = new RegExp(`<section\\b[^>]*\\b${cls}\\b[^>]*>([\\s\\S]*?)</section>`, 'i').exec(html);
    if (!match) continue;
    let section = match[1]
      .replace(/<(picture|canvas|svg)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(img|i)\b[^>]*>(?:<\/i>)?/gi, '')
      .replace(/<([a-z][a-z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '<$1>');
    if (cls === 'ct-jobs-detail-benefits') {
      const items = [...section.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)]
        .map((item) => item[1].trim())
        .filter(Boolean);
      const heading = /<h3>([\s\S]*?)<\/h3>/i.exec(section)?.[0] || '';
      section = items.length ? `${heading}<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '';
    }
    if (section.trim()) parts.push(section);
  }
  return parts.join('\n');
}

/**
 * Fetch one detail page and pull out structured fields + description.
 * Returns null (never throws) if the fetch fails — caller skips the stub.
 */
async function fetchJobDetail(url) {
  let html;
  try {
    html = await fetchHtml(url, { headers: { 'User-Agent': BROWSER_UA } });
  } catch (err) {
    console.warn(`  ⚠️ detail fetch failed (${url}): ${err?.message || err}`);
    return null;
  }

  const titleMatch = html.match(/<meta name="title" content="([^"]*)"/i);
  const rawTitle = titleMatch ? titleMatch[1] : '';
  // Title meta reads "Job Title • Brand Name" — keep the job title only.
  const title = normalizeSpace((rawTitle.split('•')[0] || ''));

  const shortLocation = extractTooltipField(html, 'Job location');
  const publicationDateRaw = extractTooltipField(html, 'Publication date');
  const referenceNumber = extractTooltipField(html, 'Reference number');
  const fieldOfActivity = extractTooltipField(html, 'Field of Activity');
  const careerLevel = extractTooltipField(html, 'Career Level');
  const employmentLabel = extractTooltipField(html, 'Employment Type');

  // "Street, PLZ City, Region, Country" — only present for jobs tied to
  // a physical site (absent for canton-wide agency-partner postings).
  const addrMatch = html.match(
    /<h3 class="uk-heading-medium">([^<]*)<\/h3>\s*<p>([^<]*)<\/p>/i,
  );
  let addrCity = '';
  let addrPostal = '';
  let addrStreet = '';
  let addrRegion = '';
  if (addrMatch) {
    const parts = normalizeSpace(addrMatch[2]).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      addrStreet = parts[0];
      const cityPart = parts[1].match(/^(\d{4,5})\s*(.+)$/);
      if (cityPart) {
        addrPostal = cityPart[1];
        addrCity = cityPart[2];
      } else {
        addrCity = parts[1];
      }
      addrRegion = parts.length >= 3 ? parts[2] : '';
    }
  }

  const bodyMatch = html.match(
    /ct-jobs-detail-text">([\s\S]*?)<div class="uk-width-1-3@m">/i,
  );
  // "Agenturpartner" (agency-partner franchise) postings use a distinct
  // multi-section landing-page template with no `.ct-jobs-detail-text`
  // block at all — see `extractAgencyTemplateHtml`.
  const descriptionHtml = bodyMatch ? bodyMatch[1] : extractAgencyTemplateHtml(html);

  return {
    title,
    shortLocation,
    publicationDateRaw,
    referenceNumber,
    fieldOfActivity,
    careerLevel,
    employmentLabel,
    addrCity,
    addrPostal,
    addrStreet,
    addrRegion,
    descriptionHtml,
  };
}

/** Fetch Switzerland-only Valora jobs from the portal's first-party API. */
async function fetchJobListings() {
  console.log(`  Fetching Switzerland listing API (${VALORA_API_URL})`);
  const byId = new Map();
  let total = null;
  let totalPages = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      'criteria[jobCountry][0]': '1',
      limit: String(API_PAGE_LIMIT),
      page: String(page),
      locale: 'de',
    });
    const pageUrl = `${VALORA_API_URL}?${params}`;
    let body;
    try {
      body = await fetchHtml(pageUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': BROWSER_UA,
        },
      });
    } catch (err) {
      console.warn(`  ⚠️ listing API fetch failed (${pageUrl}): ${err?.message || err}`);
      throw err;
    }

    const response = parseValoraApiResponse(body);
    if (response.page !== page) {
      throw new Error(`Valora API returned page ${response.page} for requested page ${page}`);
    }
    if (total !== null && total !== response.totalCount) {
      throw new Error(`Valora API totalCount changed during pagination (${total}/${response.totalCount})`);
    }
    if (totalPages !== null && totalPages !== response.totalPages) {
      throw new Error(`Valora API totalPages changed during pagination (${totalPages}/${response.totalPages})`);
    }
    total = response.totalCount;
    totalPages = response.totalPages;

    let added = 0;
    for (const listing of response.listings) {
      if (byId.has(listing.id)) continue;
      byId.set(listing.id, listing);
      added++;
    }

    console.log(`  📄 page ${page}: +${added} (collected ${byId.size}${total ? `/${total}` : ''})`);

    if (response.listings.length === 0 && total > 0) {
      throw new Error(`Valora API returned an empty page before totalCount ${total} was collected`);
    }
    if (total === 0 || byId.size >= total) break;
    if (page >= totalPages) {
      throw new Error(`Valora API pagination ended at ${byId.size}/${total} jobs`);
    }
  }

  if (total === null || totalPages === null) throw new Error('Valora API returned no pagination metadata');
  if (byId.size !== total) throw new Error(`Valora API snapshot incomplete: collected ${byId.size}/${total} jobs`);
  const listings = [...byId.values()];
  console.log(`  🔗 ${listings.length} API job records normalized`);
  return listings;
}

/**
 * Fetch all Valora Group jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step in the translate-pending pipeline.
 */
export async function fetchAllValoraJobs() {
  console.log(`🔍 Fetching ${VALORA_COMPANY_NAME} jobs`);
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
    const { detail } = listing;
    const title = normalizeSpace(detail.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.url;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, postalCode, streetAddress, region } = resolveAddress({
      city: detail.addrCity,
      shortLocation: detail.shortLocation,
      postalCode: detail.addrPostal,
      streetAddress: detail.addrStreet,
      region: detail.addrRegion,
    });
    const location = normalizeSpace(city || HQ.city);
    const canton =
      inferSwissTargetCanton(location) ||
      inferSwissTargetCanton(`${location} ${region}`) ||
      HQ.canton;

    const descriptionText = normalizeSpace(stripHtml(detail.descriptionHtml || ''));
    const description = descriptionText ||
      `${title} presso ${VALORA_COMPANY_NAME} a ${location}. Valora è un gruppo svizzero leader nel "foodvenience" (k kiosk, Brezelkönig, Press & Books, avec, Caffè Spettacolo, ok.–), con sede a Muttenz (BL). Candidati su career.valora.com.`;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} valora ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(detail.employmentLabel || '');
    const publication = sourcePostingDateFields(parseValoraDate(detail.publicationDateRaw));

    const job = {
      // ── Required fields ──
      id: `${VALORA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VALORA_COMPANY_NAME,
      companyKey: VALORA_KEY,
      companyDomain: VALORA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Valora Group Dedicated Parser (Custom)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, detail.fieldOfActivity),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(detail.careerLevel, title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      ...publication,
      applyUrl: detail.applyUrl || publicUrl,
      jobReqId: detail.referenceNumber || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  const unique = dedupeRepostedValoraJobs(jobs);
  if (unique.length < jobs.length) {
    console.log(`  🧹 ${jobs.length - unique.length} re-posted duplicate(s) dropped (same title, store address and body)`);
  }
  console.log(`\n📋 Total ${VALORA_COMPANY_NAME} jobs discovered: ${unique.length}`);
  return unique;
}

function valoraJobNumber(url = '') {
  const match = /\/job\/(\d+)\//.exec(String(url || ''));
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * Valora opens several requisitions for the same store role and publishes each
 * as its own page with an identical title, store address and body: four
 * "barista Caffè Spettacolo - 16.4 h" at Rue des Terreaux 25, Lausanne
 * (jobs 5996/5997/6001/6002, reference numbers 21299-21301…), two BackWerk
 * Sihlquai C5 Zürich (6414/6417), 12 of 48 published jobs on 2026-09-29.
 * On the site they are one vacancy shown N times. Keep one per identical
 * (title, street, postal code, locality, body); the lowest job number wins so
 * the surviving id stays stable across runs whatever the listing order.
 */
export function dedupeRepostedValoraJobs(jobs = []) {
  const fold = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const byKey = new Map();
  for (const job of jobs) {
    const key = [job.title, job.streetAddress, job.postalCode, job.addressLocality, job.description].map(fold).join('|');
    const kept = byKey.get(key);
    if (!kept || valoraJobNumber(job.url) < valoraJobNumber(kept.url)) byKey.set(key, job);
  }
  const survivors = new Set(byKey.values());
  return jobs.filter((job) => survivors.has(job));
}

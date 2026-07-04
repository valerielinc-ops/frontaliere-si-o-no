#!/usr/bin/env node
/**
 * Valora Group job parser — genuinely custom career site (regex-based
 * HTML scraping; no known multi-tenant ATS signature found).
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
 * ATS discovery: issue #3337 tagged this company's ATS as "Custom" —
 * confirmed correct on live inspection (unlike several other companies
 * in the same backlog wave whose "Custom" tag turned out to be wrong).
 * career.valora.com serves server-rendered HTML from a bespoke
 * recruiting module built by Swiss agency cloudtec AG (script paths
 * /bundles/cloudtecadmin/…, /bundles/cloudtecvalora/…, /adminui/…;
 * cloudtec.ch is a Bern-based web-platform shop that builds bespoke
 * installs per client, not a multi-tenant ATS product). No known ATS
 * signature was found on the page or its network requests: no
 * smartrecruiters.com / myworkdayjobs.com / successfactors.com /
 * icims.com / greenhouse.io (incl. boards-api.greenhouse.io) /
 * lever.co / personio / softgarden / talentsoft / join.com / recruitee
 * / cornerstone script src, XHR/fetch endpoint, iframe, or footer
 * recruiter-login link leaking a real ATS host. No JSON API and no
 * JSON-LD JobPosting block either — plain server-rendered HTML — so
 * this parser scrapes it directly with regex (no cheerio/jsdom,
 * consistent with the rest of the codebase, e.g. deloitte-job-parser.mjs
 * for a similarly-shaped genuinely-custom Avature scrape).
 *
 * Listing: https://career.valora.com/en/?criteria[jobCountry][]=1&page=N
 * (jobCountry option value "1" == Switzerland, confirmed against the
 * <select id="criteria_jobCountry"> filter facet on the listing page),
 * ~20 jobs/page, paginated via ?page=N. A page beyond the last one
 * echoes the previous page's content byte-for-byte (used as one of the
 * stop conditions, alongside job-id dedup and the "NN entries" total).
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
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VALORA_KEY = 'valora';
export const VALORA_COMPANY_NAME = 'Valora Group';
export const VALORA_COMPANY_DOMAIN = 'valora.com';

const LISTING_BASE = 'https://career.valora.com/en/';
const CAREER_URL = 'https://career.valora.com/en/';
// jobCountry option value "1" == Switzerland (from the listing page's
// <select id="criteria_jobCountry"> filter facet — confirmed live).
const LISTING_QS = 'criteria%5BjobCountry%5D%5B%5D=1';
const MAX_PAGES = 15; // safety cap (~20/page; site currently lists 53 CH jobs across 3 pages)

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
  if (/intern|apprentice|trainee|lehrling|lernend/.test(level)) return 'intern';
  if (/senior|lead|head|director|manager|geschäftsführ/.test(level)) return 'senior';

  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|trainee)/.test(t)) return 'intern';
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

function parseValoraDate(raw = '') {
  const m = String(raw || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
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
  // block at all — fall back to the prose column of their "Summary"
  // (`#in-kuerze`) section, the closest equivalent to a role description
  // on that template. Captures only the `<p>` column itself (not the
  // enclosing `<h3>`/wrapper `<div>`), because the wrapper's
  // `uk-scrollspy="target: > *; ..."` attribute contains a literal `>`
  // that breaks this codebase's simple `<[^>]+>` tag-stripper mid-attribute.
  const nutshellMatch = !bodyMatch
    ? html.match(/uk-width-3-5@m uk-width-1-2@l">([\s\S]*?)<\/div>\s*<div class="uk-width-2-5@m/i)
    : null;
  const descriptionHtml = bodyMatch ? bodyMatch[1] : (nutshellMatch ? nutshellMatch[1] : '');

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

/**
 * Fetch Switzerland-only Valora job listing stubs, paginating through
 * `?page=N` until a page adds no new job ids, the declared "NN entries"
 * total is reached, or MAX_PAGES is hit. Then enriches each stub with
 * its detail page (address, description, structured tags).
 */
async function fetchJobListings() {
  console.log(`  Fetching Switzerland listing (${CAREER_URL}?${LISTING_QS})`);
  const byId = new Map();
  let total = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = `${LISTING_BASE}?${LISTING_QS}&page=${page}`;
    let html;
    try {
      html = await fetchHtml(pageUrl, { headers: { 'User-Agent': BROWSER_UA } });
    } catch (err) {
      console.warn(`  ⚠️ listing page fetch failed (${pageUrl}): ${err?.message || err}`);
      break;
    }

    const totalMatch = html.match(/(\d+)\s*entries/i);
    if (totalMatch) total = Number(totalMatch[1]);

    const stubs = parseListingPage(html);
    let added = 0;
    for (const stub of stubs) {
      if (byId.has(stub.id)) continue;
      byId.set(stub.id, stub);
      added++;
    }

    console.log(`  📄 page ${page}: +${added} (collected ${byId.size}${total ? `/${total}` : ''})`);

    if (stubs.length === 0 || added === 0) break;
    if (total && byId.size >= total) break;
  }

  const stubs = [...byId.values()];
  console.log(`  🔗 ${stubs.length} job detail pages to enrich`);

  const listings = [];
  for (const stub of stubs) {
    const detail = await fetchJobDetail(stub.url);
    if (!detail) continue;
    listings.push({ ...stub, detail });
    await new Promise((r) => setTimeout(r, 200));
  }
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
    const postedDate =
      parseValoraDate(detail.publicationDateRaw) ||
      new Date().toISOString().split('T')[0];

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
      postedDate,
      applyUrl: publicUrl,
      jobReqId: detail.referenceNumber || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${VALORA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

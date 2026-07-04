#!/usr/bin/env node
/**
 * Swisslog job parser — bespoke in-house Sitecore CMS JSON API (NOT an ATS).
 *
 * Source: https://www.swisslog.com/en-us/careers (public career page).
 *
 * Swisslog is a global intralogistics / robotics-automation company (part
 * of the KUKA Group) with its main Swiss site in Buchs, canton Aargau
 * (Webereiweg 3, 5033 Buchs AG — see COMPANY_HQ['swisslog'] in
 * crawler-location-config.mjs for full verification notes: Zefix +
 * Moneyhouse + the site's own de-de Organization JSON-LD all agree on
 * "Buchs (AG)", NOT the "Buchs ZH" claimed by the issue #3337 backlog row).
 *
 * ATS discovery: the rendered careers/openings page shows no trace of any
 * known ATS signature (grepped for smartrecruiters|workday|myworkdayjobs|
 * successfactors|personio|softgarden|greenhouse|lever.co|icims|join.com|
 * recruitee|talentsoft|csod|cornerstone|jobs2web|solique|prospective|
 * refline — zero matches). The job-list widget instead calls Swisslog's own
 * first-party Sitecore-backed REST endpoint:
 *   GET https://www.swisslog.com/en-us/api/job/getjobs?searchrootpath=24F53394AB4E44F1A28C930664FDC228
 * (the `data-url` attribute on `#mod-joblist` in the openings page HTML).
 * This single endpoint returns EVERY open posting company-wide across every
 * locale in one JSON payload (`items: [{ headline, href, facetsTop:
 * [locationLabel], date, item_id, ... }]`, no pagination) — confirmed no
 * ATS tenant/vendor is involved; this is genuinely custom.
 *
 * Per-posting detail pages (both en-us and de-de locale hrefs observed in
 * the SAME listing payload) each embed a single `application/ld+json`
 * script containing an array of schema.org objects; the LAST array element
 * is a full `JobPosting` (datePosted, employmentType, jobLocation.address,
 * identifier, and — importantly — a `description` field that ALREADY
 * contains the complete Responsibilities + Requirements HTML, not a
 * truncated teaser). A second, separate `<div class="mod mod-text">` block
 * further down the page ("Our promise to you" / "About Swisslog") carries
 * additional boilerplate company context not present in the JobPosting
 * description; it is appended (deduped against the JobPosting text) as
 * enrichment so short per-posting content classes stay well above the
 * 50-word thin-content floor.
 *
 * jobLocation.address in the JSON-LD never carries streetAddress/postalCode
 * (both null on every posting observed) — only addressLocality (e.g.
 * "Buchs", "Mägenwil"). resolveAddress()/resolveCanton() below fill the
 * verified HQ street/postal ONLY when the city text matches Buchs, and
 * force canton 'AG' for both confirmed Swiss towns (Buchs, Mägenwil) —
 * deliberately NOT delegating to the generic inferSwissTargetCanton() for
 * "Buchs" alone, because SWISS_CANTONS.SG's curated name list includes the
 * bare town token "buchs" (Buchs SG) with no canton disambiguation, which
 * would otherwise silently misroute this company to St. Gallen.
 *
 * No `./ats-clients/*` shared client is used — there is no ATS. This
 * reuses only the generic low-level helpers (fetchJson/fetchHtml/stripHtml)
 * from crawler-template.mjs, matching the established bespoke-parser
 * pattern (cf. staubli-job-parser.mjs, belimo-job-parser.mjs).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSwisslogJobs() — Fetch and parse all Swiss jobs
 *   - isSwisslogJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { stripContactPII } from './strip-contact-pii.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SWISSLOG_KEY = 'swisslog';
export const SWISSLOG_COMPANY_NAME = 'Swisslog';
export const SWISSLOG_COMPANY_DOMAIN = 'swisslog.com';

const CAREER_URL = 'https://www.swisslog.com/en-us/careers/openings';

// Sitecore job-search API backing the openings page's `#mod-joblist` widget
// (see `data-url` attribute). Returns every open posting company-wide,
// across all locales, in a single unpaginated payload.
const LISTING_API_URL =
  'https://www.swisslog.com/en-us/api/job/getjobs?searchrootpath=24F53394AB4E44F1A28C930664FDC228';

/* ── HQ fallback (Webereiweg 3, 5033 Buchs, AG) ──────────────── */
/* See scripts/lib/crawler-location-config.mjs COMPANY_HQ['swisslog'] for
 * full verification notes (Zefix + Moneyhouse + de-de Organization JSON-LD).
 */
const HQ = {
  city: 'Buchs',
  canton: 'AG',
  postalCode: '5033',
  streetAddress: 'Webereiweg 3',
  region: 'Aargau',
};

const SECTOR = 'Logistica / Automazione';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Swisslog.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSwisslogJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SWISSLOG_KEY ||
    key.startsWith('swisslog') ||
    company.includes('swisslog') ||
    url.includes('swisslog.com')
  );
}

/**
 * Validate that a URL belongs to Swisslog's own domain — there is no
 * 3rd-party ATS host involved, the job API/pages live directly on
 * www.swisslog.com.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'swisslog.com' || host.endsWith('.swisslog.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|architect)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|meccatron|mechatron|automatiker|controls)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|intralogist)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|montage|fertigung|assembly)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|cyber|security)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|efz|working student)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Normalize schema.org employmentType values (already emitted verbatim by
 * Swisslog's own JSON-LD) to our internal set, with a title-based part-time
 * percentage override (Swiss job titles commonly carry a "(NN%)" workload
 * suffix that schema.org's coarse FULL_TIME/TEMPORARY split doesn't capture).
 */
function normalizeEmploymentType(rawType = '', title = '') {
  const pctMatch = title.match(/\((\d{1,3})\s*(?:-\s*(\d{1,3})\s*)?%\)/);
  if (pctMatch) {
    const nums = [pctMatch[1], pctMatch[2]].filter(Boolean).map(Number);
    if (nums.length && Math.max(...nums) < 100) return 'PART_TIME';
  }
  const t = normalize(rawType);
  if (t.includes('part_time') || t.includes('part-time')) return 'PART_TIME';
  if (t.includes('full_time') || t.includes('full-time')) return 'FULL_TIME';
  if (t.includes('temporary')) return 'TEMPORARY';
  if (t.includes('intern')) return 'INTERN';
  return t ? 'OTHER' : 'FULL_TIME';
}

/* ── Address / Canton Resolution ──────────────────────────────
 * IMPORTANT: gated on the job's resolved CITY TEXT, never on canton alone.
 * See the module header + crawler-location-config.mjs COMPANY_HQ['swisslog']
 * for why "Buchs" cannot be delegated to inferSwissTargetCanton() alone.
 */

const HQ_CITY_RX = /\bbuchs\b/i;
// Mägenwil (canton Aargau, near Wohlen) is a second confirmed Swisslog CH
// site (a maintenance/service role observed there), but its exact street
// address has not been independently verified — canton is forced to the
// correct 'AG' without guessing a street/postal HQ fallback for it.
const SECONDARY_AG_CITY_RX = /\bm[äa]genwil\b/i;

/**
 * Resolve the canton for a job, or signal (via null) that it should be
 * skipped. The crawl is Switzerland-wide (not restricted to Buchs/Mägenwil),
 * so a real city text that doesn't resolve to any known Swiss canton must
 * never fabricate the Buchs HQ canton (AG) for a job that isn't positively
 * there (AGENTS.md Non-Negotiable #3, mirrors clariant-job-parser.mjs).
 *
 * @param {string} realCityText - city text as scraped, BEFORE resolveAddress's HQ.city fallback
 */
export function resolveCanton(cityText = '', region = '', realCityText = cityText) {
  if (HQ_CITY_RX.test(cityText) || SECONDARY_AG_CITY_RX.test(cityText)) return 'AG';
  const inferredCanton = inferSwissTargetCanton(cityText) || inferSwissTargetCanton(`${cityText} ${region}`);
  if (inferredCanton) return inferredCanton;
  if (normalizeSpace(realCityText)) return null;
  return HQ.canton;
}

function resolveAddress(rawLoc = {}) {
  const city = (rawLoc.city || rawLoc.fullLocation || '').trim();
  const postalCode = (rawLoc.postalCode || '').trim();
  const streetAddress = (rawLoc.address || '').trim();
  const region = (rawLoc.region || '').trim();
  const isVerifiedHqCity = !city || HQ_CITY_RX.test(city);

  return {
    city: city || HQ.city,
    postalCode: postalCode || (isVerifiedHqCity ? HQ.postalCode : ''),
    streetAddress: streetAddress || (isVerifiedHqCity ? HQ.streetAddress : ''),
    region,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

const LD_JSON_RX = /<script type="application\/ld\+json">\s*(\[[\s\S]*?\])\s*<\/script>/;

/** Extract the JobPosting object from a detail page's ld+json array. */
function extractJobPosting(html = '') {
  const m = html.match(LD_JSON_RX);
  if (!m) return null;
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  return arr.find((entry) => entry && entry['@type'] === 'JobPosting') || null;
}

// Matches each `<div class="mod mod-text" ...><div class="row">...
// <div class="copy">{content}</div></div></div></div>` block on a detail
// page. The FIRST such block duplicates the JobPosting's own intro
// paragraph (deduped below); a SECOND ("Our promise to you" / "About
// Swisslog") carries additional context not present in the JSON-LD.
const COPY_BLOCK_RX = /<div class="mod mod-text"[^>]*>[\s\S]*?<div class="copy">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g;

/**
 * Extract extra "mod-text" boilerplate paragraphs not already present in
 * the JobPosting description, for description enrichment.
 */
function extractBoilerplate(html = '', descriptionText = '') {
  const rx = new RegExp(COPY_BLOCK_RX.source, 'g');
  const extras = [];
  let m;
  while ((m = rx.exec(html))) {
    const text = stripHtml(m[1] || '');
    if (!text || text.length < 20) continue;
    const probe = text.slice(0, 40);
    if (descriptionText && descriptionText.includes(probe)) continue; // dedup intro block
    extras.push(text);
  }
  return extras.join('\n\n');
}

/**
 * Fetch the Swiss-only Swisslog postings from the company's own job-search
 * API (unpaginated, all locales in one payload), then fetch each Swiss
 * posting's detail page for the full JSON-LD JobPosting + boilerplate.
 * Returns an array of raw listing objects.
 */
async function fetchJobListings() {
  console.log('   Fetching Swisslog job-search API (Switzerland-only filter)');
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const payload = await fetchJson(LISTING_API_URL, { timeoutMs });
  const items = Array.isArray(payload?.items) ? payload.items : [];
  console.log(`   Listings found (worldwide): ${items.length}`);

  const swissItems = items.filter((item) => {
    const locationLabel = Array.isArray(item?.facetsTop) ? item.facetsTop.join(' ') : '';
    return /switzerland|schweiz|suisse|svizzera/i.test(locationLabel);
  });
  console.log(`   Swiss listings: ${swissItems.length} / ${items.length} total`);

  const listings = [];
  for (const item of swissItems) {
    const href = item?.href;
    if (!href) continue;
    try {
      const html = await fetchHtml(href, { timeoutMs });
      const jobPosting = extractJobPosting(html);
      if (!jobPosting) {
        console.warn(`⚠️ No JobPosting JSON-LD found for ${href}`);
        continue;
      }

      const rawDescriptionHtml = jobPosting.description || '';
      const descriptionText = stripHtml(rawDescriptionHtml);
      const boilerplate = extractBoilerplate(html, descriptionText);

      const address = jobPosting.jobLocation?.address || {};
      const locationLabel = Array.isArray(item?.facetsTop) && item.facetsTop.length
        ? item.facetsTop[0]
        : '';
      const cityRaw = normalizeSpace(
        address.addressLocality || (locationLabel.split(',')[0] || ''),
      );

      listings.push({
        title: normalizeSpace(item.headline || ''),
        href,
        descriptionHtml: rawDescriptionHtml,
        boilerplate,
        locationLabel,
        cityRaw,
        rawAddress: address,
        employmentType: jobPosting.employmentType || '',
        datePosted: jobPosting.datePosted || '',
        jobReqId: jobPosting.identifier?.value || null,
      });
    } catch (err) {
      console.warn(`⚠️ Detail fetch failed for ${href}: ${err?.message || err}`);
    }
  }

  return listings;
}

/**
 * Fetch all Swisslog jobs (Switzerland only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSwisslogJobs() {
  console.log(`🔍 Fetching ${SWISSLOG_COMPANY_NAME} jobs`);
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

    const publicUrl = listing.href;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, postalCode, streetAddress, region } = resolveAddress({
      city: listing.cityRaw,
      fullLocation: listing.locationLabel,
      postalCode: listing.rawAddress?.postalCode || '',
      address: listing.rawAddress?.streetAddress || '',
    });
    const location = normalizeSpace(listing.locationLabel || city || HQ.city);
    const realCityText = normalizeSpace(listing.cityRaw || listing.locationLabel || '');
    const canton = resolveCanton(city, region, realCityText);
    if (canton === null) {
      console.warn(` ⚠️ Swisslog: skipping unresolvable location "${realCityText}" (${title})`);
      continue;
    }

    const descriptionCore = stripHtml(listing.descriptionHtml || '');
    const descriptionParts = [descriptionCore, listing.boilerplate].filter(Boolean);
    const descriptionRaw = descriptionParts.join('\n\n')
      || `${title} presso ${SWISSLOG_COMPANY_NAME} a ${location}.`;
    const description = stripContactPII(descriptionRaw);

    const sourceLang = detectLang(descriptionCore || title, 'de');
    const jobSlug = slugify(`${title} swisslog ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = normalizeEmploymentType(listing.employmentType, title);
    const postedDate = (listing.datePosted && String(listing.datePosted).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const jobReqIdMatch = publicUrl.match(/-(\d+)\/?$/);
    const jobReqId = jobReqIdMatch ? jobReqIdMatch[1] : (listing.jobReqId || null);

    const job = {
      // ── Required fields ──
      id: `${SWISSLOG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SWISSLOG_COMPANY_NAME,
      companyKey: SWISSLOG_KEY,
      companyDomain: SWISSLOG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Swisslog Dedicated Parser (custom Sitecore job API)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
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
      jobReqId,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SWISSLOG_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

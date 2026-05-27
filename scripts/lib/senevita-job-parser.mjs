#!/usr/bin/env node
/**
 * Senevita job parser — Bernese network of care homes + Spitex (emeis Schweiz).
 *
 * Public career site: https://jobs.senevita.ch/ (rexx systems ATS)
 *
 * Senevita AG is one of the largest Swiss operators of assisted living and
 * long-term care, with ~30 locations across BE / VD / AG / ZH / SO / TG.
 * Headquartered in Muri b. Bern. Owned by emeis (formerly Orpea).
 *
 * Crawl strategy:
 *
 *   1. GET https://jobs.senevita.ch/stellenangebote.html?start={0,100,200,…}
 *      — server-rendered listing pages, 100 results per page. Each card is
 *      `<div class="joboffer_container" onclick="window.location.href='…'">`
 *      with an anchor `<a href="/{slug}-de-j{ID}.html">{TITLE}</a>` inside
 *      `<div class="joboffer_title_text joboffer_box">` and a location string
 *      inside `<div class="joboffer_informations">`.
 *
 *   2. For each job, GET the detail URL — it contains an inline
 *      `<script type="application/ld+json">{ "@type": "JobPosting", … }</script>`
 *      block with `responsibilities`, `qualifications`, `jobBenefits`,
 *      `description`, `datePosted`, `validThrough`, `employmentType`,
 *      `jobLocation.address` and `hiringOrganization`. We assemble the full
 *      description text from the HTML body of the four content fields.
 *
 * Notes:
 *   - rexx systems blocks generic UAs (`curl`, `python-requests`, …). We use
 *     the standard `FrontaliereTicinoBot` UA — accepted in practice.
 *   - Locations are typed as "Senevita {LocationName}" — the postal code is
 *     in the JSON-LD address block, not the listing card, so we resolve the
 *     canton via the JSON-LD `addressRegion` + `inferSwissTargetCanton`.
 *   - The site is German-only (DE) with some FR/IT jobs scattered in. We
 *     detect via JSON-LD or fall back to title heuristics.
 *   - All parsed jobs ship with `needsRetranslation: true` so the shared AI
 *     localization step fills FR/IT/EN slots.
 *
 * Implements the 4 exports required by the standard crawler template.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const SENEVITA_KEY = 'senevita';
export const SENEVITA_COMPANY_NAME = 'Senevita';
export const SENEVITA_COMPANY_DOMAIN = 'senevita.ch';
const BASE_URL = 'https://jobs.senevita.ch';
const LISTING_PAGE_SIZE = 100;
const DETAIL_DELAY_MS = 200;

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/** Map JSON-LD addressRegion (Swiss canton names) → ISO canton codes. */
const REGION_TO_CANTON = {
  aargau: 'AG', 'argovia': 'AG',
  bern: 'BE', berna: 'BE', berne: 'BE',
  zurich: 'ZH', zürich: 'ZH',
  vaud: 'VD', waadt: 'VD',
  solothurn: 'SO', soletta: 'SO',
  thurgau: 'TG', turgovia: 'TG',
  luzern: 'LU', lucerne: 'LU', lucerna: 'LU',
  fribourg: 'FR', freiburg: 'FR', friborgo: 'FR',
  schaffhausen: 'SH', sciaffusa: 'SH',
  basel: 'BS', 'basel-stadt': 'BS',
  'basel-land': 'BL', 'basel-landschaft': 'BL',
  graubünden: 'GR', grigioni: 'GR',
  ticino: 'TI', tessin: 'TI',
  'st. gallen': 'SG', stgallen: 'SG',
  geneve: 'GE', genève: 'GE', genf: 'GE',
  valais: 'VS', wallis: 'VS', vallese: 'VS',
  neuchatel: 'NE', neuchâtel: 'NE',
  jura: 'JU',
  zug: 'ZG',
  glarus: 'GL',
  uri: 'UR', schwyz: 'SZ', obwalden: 'OW', nidwalden: 'NW', 'appenzell': 'AR',
};

/* ── Listing page ─────────────────────────────────────────── */

/**
 * Parse one Senevita listing page. Returns array of `{ url, jobId, title, location }`.
 */
export function parseSenevitaListing(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // Each card is a `<div class="joboffer_container" onclick="…URL…">` wrapper
  // that contains a title block and an informations block. We anchor on the
  // `window.location.href='…'` URL since it always appears in the opening tag
  // — robust against the nested </div> structure inside the card.
  const cardRe = /<div class="joboffer_container"\s+onclick="window\.location\.href='([^']+)'"[^>]*>([\s\S]*?)(?=<div class="joboffer_container"|<\/div>\s*<div class="(?:pagebar|joblist_navigator|paging|joboffer_seperator))/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const url = m[1];
    const idMatch = url.match(/-j(\d+)\.html$/);
    if (!idMatch) continue;
    const jobId = idMatch[1];
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const block = m[2];
    const titleMatch = block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch
      ? decodeEntities(normalizeSpace(stripHtml(titleMatch[1])))
      : '';
    if (!title || title.length < 3) continue;
    const locMatch = block.match(/joboffer_informations[^>]*>([\s\S]*?)<\/div>/i);
    const location = locMatch
      ? decodeEntities(normalizeSpace(stripHtml(locMatch[1]))).replace(/^[\s,]+/, '')
      : '';
    out.push({ url, jobId, title, location });
  }
  return out;
}

/* ── Detail page ──────────────────────────────────────────── */

function decodeJsonLdString(s = '') {
  // The JSON-LD block escapes forward slashes (`\/`) and uses HTML entities
  // inside HTML-content fields. JSON.parse handles `\/` natively.
  return String(s || '');
}

/**
 * Extract the first `application/ld+json` JobPosting object from the page.
 * Returns the parsed object, or null.
 */
export function extractJobPostingJsonLd(html) {
  if (!html) return null;
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(decodeJsonLdString(raw));
      if (obj && (obj['@type'] === 'JobPosting' || (Array.isArray(obj) && obj.find((o) => o['@type'] === 'JobPosting')))) {
        return Array.isArray(obj) ? obj.find((o) => o['@type'] === 'JobPosting') : obj;
      }
    } catch {
      // continue to next script block
    }
  }
  return null;
}

function pickCantonFromJsonLd(addr = {}, city = '') {
  const region = normalize(addr.addressRegion || '');
  if (region) {
    const key = region.replace(/\s+/g, '').replace(/-/g, '');
    if (REGION_TO_CANTON[region]) return REGION_TO_CANTON[region];
    if (REGION_TO_CANTON[key]) return REGION_TO_CANTON[key];
  }
  return inferSwissTargetCanton(city) || '';
}

/* ── Factory-style export ─────────────────────────────────── */

export async function fetchAllSenevitaJobs() {
  console.log(`🏥 Fetching ${SENEVITA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${BASE_URL}/stellenangebote.html (rexx systems)\n`);

  // Step 1 — walk listing pages
  const listings = [];
  const seenIds = new Set();
  for (let start = 0; start < 1000; start += LISTING_PAGE_SIZE) {
    const url = `${BASE_URL}/stellenangebote.html?start=${start}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      if (start === 0) throw err;
      console.warn(`  ⚠️ Pagination failed at start=${start}: ${err?.message || err}`);
      break;
    }
    const rows = parseSenevitaListing(html);
    let added = 0;
    for (const r of rows) {
      if (seenIds.has(r.jobId)) continue;
      seenIds.add(r.jobId);
      listings.push(r);
      added += 1;
    }
    console.log(`  📄 start=${start}: +${added} (total: ${listings.length})`);
    if (added === 0) break;
    if (rows.length < LISTING_PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  if (!listings.length) {
    console.warn(`⚠️ No listings found on ${BASE_URL}`);
    return [];
  }
  console.log(`  📋 Total listings discovered: ${listings.length}\n`);

  // Step 2 — fetch detail pages
  const jobs = [];
  for (const listing of listings) {
    let posting = null;
    try {
      const detailHtml = await fetchHtml(listing.url);
      posting = extractJobPostingJsonLd(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.title} (${listing.jobId}): ${err?.message || err}`);
    }

    const title = decodeEntities(posting?.title || listing.title || '').trim();
    if (!title) continue;

    const addr = posting?.jobLocation?.address || {};
    const city = decodeEntities(addr.addressLocality || '').trim()
      || (listing.location ? listing.location.split(/[,–-]/)[0].replace(/^Senevita\s+/i, '').trim() : '')
      || 'Muri b. Bern';
    const postalCode = String(addr.postalCode || '').trim() || '3074';
    const canton = pickCantonFromJsonLd(addr, city) || 'BE';

    // Build description from JSON-LD fields (HTML → plain text)
    const descParts = [];
    if (posting?.description) descParts.push(htmlToText(posting.description));
    if (posting?.responsibilities) descParts.push(`Aufgaben\n${htmlToText(posting.responsibilities)}`);
    if (posting?.qualifications) descParts.push(`Anforderungen\n${htmlToText(posting.qualifications)}`);
    if (posting?.jobBenefits) descParts.push(`Wir bieten\n${htmlToText(posting.jobBenefits)}`);
    let description = descParts.filter(Boolean).join('\n\n').trim();

    // Boilerplate guard
    const uniqueWords = new Set(
      description.toLowerCase().replace(/[^a-zà-ÿäöüß\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
    );
    if (uniqueWords.size < 30) {
      description = `${title} bei ${SENEVITA_COMPANY_NAME} in ${city}.\n\n${SENEVITA_COMPANY_NAME} ist einer der grössten Schweizer Anbieter von betreutem Wohnen und Langzeitpflege mit rund 30 Standorten. Diese Stelle bietet ein modernes Arbeitsumfeld, attraktive Anstellungsbedingungen und vielfältige Weiterbildungsmöglichkeiten.`;
    }

    const sourceLang = detectLang(description || title, 'de');
    const postedDate = (() => {
      const raw = posting?.datePosted || '';
      if (!raw) return new Date().toISOString().slice(0, 10);
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    })();
    const validThrough = (() => {
      const raw = posting?.validThrough || '';
      if (!raw) return '';
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    })();

    const employmentTypeRaw = String(posting?.employmentType || '').toUpperCase();
    const employmentType = employmentTypeRaw === 'PART_TIME' || /\b(50|60|70|80)\s?%/.test(title)
      ? 'PART_TIME'
      : (employmentTypeRaw === 'FULL_TIME' ? 'FULL_TIME' : detectHealthcareEmploymentType(title));

    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} ${SENEVITA_KEY} ${city}`);

    const job = {
      id: `${SENEVITA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SENEVITA_COMPANY_NAME,
      companyKey: SENEVITA_KEY,
      companyDomain: SENEVITA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Flag for the shared AI-localization pipeline. Without it the locale-
      // completeness gate trips before translation can run. translate-pending
      // .yml picks up jobs that still have the flag set on cache miss.
      needsRetranslation: true,
      location: city,
      canton,
      url: listing.url,
      source: 'Senevita Dedicated Parser (rexx systems)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      ...(validThrough ? { validThrough } : {}),
      applyUrl: listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };
    jobs.push(job);

    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const k = job.url.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(job);
  }
  console.log(`\n📋 Total unique ${SENEVITA_COMPANY_NAME} jobs: ${deduped.length}`);
  return deduped;
}

export function isSenevitaJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  if (key === SENEVITA_KEY) return true;
  if (company.includes('senevita')) return true;
  if (url.includes('jobs.senevita.ch') || url.includes('senevita.ch')) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.senevita.ch'
      || host === 'senevita.ch'
      || host === 'www.senevita.ch'
      || host.endsWith('.senevita.ch');
  } catch {
    return false;
  }
}

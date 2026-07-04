#!/usr/bin/env node
/**
 * Sodexo (Suisse) SA — dedicated job parser.
 *
 * Global facility-management / collective catering conglomerate (founded
 * 1966, Marseille). Swiss entity ~650 employees across cleaning, catering,
 * corporate dining, logistics, security/reception, conference services and
 * technical facility management. Direct employer of record (NOT a staffing
 * agency) even though many roles are described "am Standort <client site>" —
 * that is normal for facility-management outsourcing, Sodexo places its own
 * payrolled staff on client premises. Watch instead for anonymized
 * "our client" phrasing (identity hidden); none observed in current listings.
 *
 * Public career site:  https://ch.sodexo.com/arbeiten-bei-sodexo/jobangebote
 * ATS:                 Concludis (classic server-rendered "prj/lst" tenant)
 * Listing URL:          https://sodexo-suisse.concludis.de/prj/lst/a181a603769c1f98ad927e7367c7aa51/GesamtlisteOffenePositionen.htm
 *
 * The listing page is fully server-rendered: each opening is a `<div
 * onclick="cJobboard.openJob('https://.../prj/shw/{hash}/{id}/{slug}.htm...')">`
 * block containing the title and a "Stellennummer {id} am Standort {city}
 * {postal} - {contractLabel}" summary line. Each detail page embeds a clean
 * `<script type="application/ld+json">` JobPosting object with `title`,
 * `description` (HTML), `datePosted`, `employmentType`, `jobLocation`
 * (postalCode + addressLocality + addressCountry — no streetAddress) and
 * `hiringOrganization`. No API endpoint is required; the JSON-LD covers
 * nearly everything, we backfill streetAddress from the HQ default.
 *
 * Polite delay: 300 ms between detail fetches.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { guessCategory } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
} from './hospital-custom-html-helpers.mjs';

export const SODEXO_KEY = 'sodexo';
export const SODEXO_COMPANY_NAME = 'Sodexo (Suisse) SA';
export const SODEXO_COMPANY_DOMAIN = 'sodexo.ch';

const TENANT_HASH = 'a181a603769c1f98ad927e7367c7aa51';
const PORTAL_BASE = 'https://sodexo-suisse.concludis.de';
const LISTING_URL = `${PORTAL_BASE}/prj/lst/${TENANT_HASH}/GesamtlisteOffenePositionen.htm`;
const DETAIL_DELAY_MS = 300;
const MIN_DESC_WORDS = 50;

// HQ fallback (Glattbrugg — Sodexo Suisse SA head office) when a job's
// jobLocation is missing a usable postal code/street (Concludis JSON-LD
// never provides streetAddress).
const HQ = {
  city: 'Glattbrugg',
  canton: 'ZH',
  postalCode: '8152',
  streetAddress: 'Wallisellenstrasse 55',
};

// Map Sodexo client-site city → Swiss canton. Concludis JSON-LD only gives
// `addressLocality` + `postalCode`, not the canton, so we infer it from the
// city name (same pattern as pallas-kliniken-job-parser.mjs / other
// multi-site dedicated crawlers).
const CITY_TO_CANTON = {
  'Baar': 'ZG',
  'Oberdorf': 'BL',
  'Lengnau BE': 'BE',
  'Lengnau': 'BE',
  'Buchs': 'SG',
  'Luzern': 'LU',
  'Zürich': 'ZH',
  'Zurich': 'ZH',
  'Zürich Flughafen': 'ZH',
  'Glattbrugg': 'ZH',
  'Schaffhausen': 'SH',
  'Winkeln SG': 'SG',
  'Winkeln': 'SG',
  'Dagmersellen': 'LU',
  'Basel': 'BS',
  'Bern': 'BE',
  'Genève': 'GE',
  'Geneva': 'GE',
  'Lausanne': 'VD',
  'Sion': 'VS',
  'Lugano': 'TI',
  'Bellinzona': 'TI',
  'Chur': 'GR',
  'St. Gallen': 'SG',
  'Winterthur': 'ZH',
  'Biel': 'BE',
  'Bienne': 'BE',
  'Fribourg': 'FR',
  'Freiburg': 'FR',
  'Neuchâtel': 'NE',
  'Aarau': 'AG',
  'Solothurn': 'SO',
  'Zug': 'ZG',
};

export function isSodexoJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  return job?.companyKey === SODEXO_KEY
    || url.includes('sodexo-suisse.concludis.de')
    || url.includes('ch.sodexo.com')
    || company.includes('sodexo');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'sodexo-suisse.concludis.de'
      || host.endsWith('.concludis.de')
      || host === 'ch.sodexo.com'
      || host.endsWith('.sodexo.com');
  } catch {
    return false;
  }
}

/**
 * Parse the Concludis "GesamtlisteOffenePositionen" listing page.
 * Extracts `{ id, title, detailUrl, location, contractLabel }` for every
 * `cJobboard.openJob('<detailUrl>')` block, paired with its `.headerlink`
 * title span and `Stellennummer {id} am Standort {city} {plz} - {label}`
 * summary text found immediately after it in the same `<div>`.
 */
export function parseSodexoListing(html = '') {
  const out = [];
  const seen = new Set();
  // Location itself may contain a bare hyphen (Concludis sometimes emits a
  // doubled "CH-" prefix inside the postal code, e.g. "Buchs CH-CH-5033"),
  // so the location/contract split relies on the SPACED " - " separator
  // (`\s-\s`) rather than excluding "-" outright — a greedy location match
  // backtracks to the last spaced hyphen before the contract label.
  const rx = /cJobboard\.openJob\('([^']+)'\);"[^>]*>\s*<span class="headerlink stellenlink">([^<]*)<\/span>\s*<span class="kurzb">(?:<br\s*\/?>)?\s*Stellennummer\s+(\d+)\s+am\s+Standort\s+([^<]+)\s-\s([^<]*)<\/span>/g;
  let m;
  while ((m = rx.exec(html))) {
    const [, detailUrl, rawTitle, id, rawLocation, rawContract] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: normalizeSpace(decodeEntities(rawTitle)),
      detailUrl: decodeEntities(detailUrl),
      locationRaw: normalizeSpace(decodeEntities(rawLocation)),
      contractLabel: normalizeSpace(decodeEntities(rawContract)),
    });
  }
  return out;
}

/**
 * Extract the JSON-LD JobPosting block from a Concludis detail page.
 * Returns `null` if not present or malformed.
 */
export function extractJobPostingLd(html = '') {
  if (!html) return null;
  const scripts = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of scripts) {
    const raw = m[1].trim();
    try {
      const data = JSON.parse(raw);
      if (data && (data['@type'] === 'JobPosting' || data['@type']?.includes?.('JobPosting'))) {
        return data;
      }
    } catch {
      // Ignore malformed blocks and keep scanning.
    }
  }
  return null;
}

function htmlDescriptionToText(htmlDescription = '') {
  const decoded = decodeEntities(String(htmlDescription));
  const text = htmlToText(decoded);
  return normalizeSpace(text);
}

// NOTE: deliberately does NOT delegate to the shared `normalizeContract()`
// with raw title text — many Sodexo titles carry a workload RANGE like
// "IT-Support (m/w/d) 70% - 100%", and normalizeContract's percent-sniffer
// keys off the *first* number in the string (would read "70%" as
// part-time even though the role is predominantly full-time / negotiable
// up to 100%). The Concludis JSON-LD `employmentType` and the listing's own
// German "Vollzeit"/"Teilzeit" label are both authoritative and unambiguous,
// so we prefer those over title-percentage sniffing.
function mapEmploymentTypeLd(value, contractLabel = '', title = '') {
  const raw = String(value || '').toUpperCase();
  if (raw.includes('PART')) return 'part-time';
  if (raw.includes('FULL')) return 'full-time';
  if (raw.includes('INTERN')) return 'internship';
  if (raw.includes('TEMP') || raw.includes('CONTRACT')) return 'contract';
  const label = String(contractLabel || '').toLowerCase();
  if (/teilzeit|geringf(ü|u)gig/.test(label)) return 'part-time';
  if (/vollzeit/.test(label)) return 'full-time';
  const t = String(title || '').toLowerCase();
  if (/lehrling|lernend|apprenti|apprendist|praktik|stage|stagiair/.test(t)) return 'internship';
  return 'full-time';
}

function detectExperienceLevel(title = '') {
  const t = title.toLowerCase();
  if (/\b(lehrling|lernend\w*|apprenti\w*|apprendist\w*|stage|stagiair\w*|praktik\w*|intern\w*)\b/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|assistent\w*|assistant\w*)\b/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|manager|leiter\w*|leitend\w*|verantwortlich\w*)\b/.test(t)) return 'senior';
  return 'mid';
}

// Concludis sometimes prefixes postalCode with a stray "CH-" (source data
// quirk, e.g. `"postalCode":"CH-5033"`). Normalize to a bare 4-digit PLZ.
function normalizePostalCode(raw = '') {
  const digits = String(raw || '').replace(/\D+/g, '');
  return /^\d{4}$/.test(digits) ? digits : '';
}

// A handful of Swiss town names are ambiguous across cantons (e.g. "Buchs"
// exists in both AG-5033 and SG-9471). Disambiguate by exact postal code
// BEFORE falling back to the city-name map.
const POSTAL_CODE_CANTON_OVERRIDES = {
  '5033': 'AG', // Buchs AG
  '9471': 'SG', // Buchs SG
  '5426': 'AG', // Lengnau AG
  '2543': 'BE', // Lengnau BE
  '4436': 'BL', // Oberdorf BL
  '6372': 'NW', // Oberdorf NW
  '4525': 'SO', // Oberdorf SO
};

function pickCanton(addressLocality, postalCode = '') {
  if (postalCode && POSTAL_CODE_CANTON_OVERRIDES[postalCode]) {
    return POSTAL_CODE_CANTON_OVERRIDES[postalCode];
  }
  if (!addressLocality) return HQ.canton;
  const direct = CITY_TO_CANTON[addressLocality];
  if (direct) return direct;
  for (const [k, v] of Object.entries(CITY_TO_CANTON)) {
    if (addressLocality.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return HQ.canton;
}

export async function fetchAllSodexoJobs() {
  console.log(`🍽️  Fetching ${SODEXO_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const positions = parseSodexoListing(listingHtml);
  console.log(`  ✓ ${positions.length} Concludis positions parsed`);
  if (!positions.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    let html;
    try {
      html = await fetchHtml(p.detailUrl);
    } catch (err) {
      console.warn(`  ⚠️ Sodexo detail fetch failed (${p.detailUrl}): ${err?.message || err}`);
      continue;
    }
    const ld = extractJobPostingLd(html);
    const title = normalizeSpace(decodeEntities(ld?.title || p.title));
    if (!title) {
      console.warn(`  ⚠️ Sodexo missing title for ${p.detailUrl}`);
      continue;
    }
    const description = htmlDescriptionToText(ld?.description || '');
    if (!description || description.split(/\s+/).filter(Boolean).length < MIN_DESC_WORDS) {
      console.warn(`  ⚠️ Sodexo thin description for ${title} (${p.detailUrl})`);
      continue;
    }
    const sourceLang = detectLang(description, 'de');

    const addr = ld?.jobLocation?.address || {};
    const rawCity = normalizeSpace(decodeEntities(addr.addressLocality || p.locationRaw || ''));
    const city = rawCity || HQ.city;
    const isHqCity = !rawCity || /glattbrugg/i.test(rawCity);
    const postalCode = normalizePostalCode(addr.postalCode)
      || (isHqCity ? HQ.postalCode : '');
    const streetAddress = addr.streetAddress
      ? normalizeSpace(decodeEntities(addr.streetAddress))
      : HQ.streetAddress;
    const canton = pickCanton(city, postalCode);

    const datePosted = (ld?.datePosted && /^\d{4}-\d{2}-\d{2}$/.test(ld.datePosted))
      ? ld.datePosted
      : todayIso;

    const jobSlug = slugify(`${title} ${SODEXO_KEY} ${city}`);
    const urlHash = createHash('sha1').update(p.detailUrl).digest('hex').slice(0, 12);
    const employmentType = mapEmploymentTypeLd(ld?.employmentType, p.contractLabel, title);

    jobs.push({
      id: `${SODEXO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SODEXO_COMPANY_NAME,
      companyKey: SODEXO_KEY,
      companyDomain: SODEXO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Source-locale-only payload. Shared AI-localize step in the standard
      // crawler pipeline fills the remaining 3 locales.
      needsRetranslation: true,
      location: city,
      canton,
      url: p.detailUrl,
      source: `${SODEXO_COMPANY_NAME} Dedicated Parser (Concludis / JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: postalCode || HQ.postalCode,
      streetAddress: streetAddress || HQ.streetAddress,
      category: guessCategory(title, description.slice(0, 400)),
      // `contract` mirrors the same authoritative signal as `employmentType`
      // (JSON-LD employmentType → German Vollzeit/Teilzeit label → title
      // internship keywords) so the two fields never contradict each other.
      contract: employmentType,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ristorazione collettiva / Facility Management',
      currency: 'CHF',
      featured: false,
      postedDate: datePosted,
      applyUrl: p.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      // baseSalary: Concludis JSON-LD never publishes a salary figure for
      // these roles; downstream job-page rendering applies the safe default
      // (canton/sector estimate) per AGENTS.md Non-Negotiable #3 — never
      // fabricated here.
    });
  }
  console.log(`\n📋 Total ${SODEXO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };

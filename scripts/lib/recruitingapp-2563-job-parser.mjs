#!/usr/bin/env node
/**
 * Switch Bewerbermanagement Stellen job parser — Fetcher and job builder.
 *
 * Source: https://recruitingapp-2563.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRecruitingapp2563Jobs()  — Fetch and parse all jobs
 *   - isRecruitingapp2563Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import {
  extractUmantisDetailFields,
  extractUmantisTitleAlternativeLocationEvidence,
} from './prospector/umantis-detail.mjs';
import {
  runUmantisSpecWithEmptyProof,
  umantisAuthoritativeEmptyOrNull,
} from './umantis-empty-listing.mjs';
import {
  resolveDetailOrListingSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RECRUITINGAPP_2563_KEY = 'recruitingapp-2563';
export const RECRUITINGAPP_2563_COMPANY_NAME = 'Switch Bewerbermanagement Stellen';
export const RECRUITINGAPP_2563_COMPANY_DOMAIN = 'recruitingapp-2563.umantis.com';

const CAREER_URL = 'https://recruitingapp-2563.umantis.com/Jobs/1?lang=ger&ContentOnly=&message=';

// Switch publishes the workplace in the vacancy title; the Umantis detail page
// may also carry only the employer's generic address. Single-site titles and
// explicitly Swiss alternatives are source-backed evidence, while any title
// that cannot prove a Swiss site remains fail-closed.
const SWITCH_SINGLE_CITY_TITLE_RX = /\bin\s+(Zürich|Zurich|Lausanne)\s*$/i;
const SWITCH_SUPPORTED_CITY_RX = /\b(Zürich|Zurich|Lausanne)\b/gi;
const SWITCH_DESCRIPTION_START_RX = /<h1\b[^>]*>[\s\S]{0,2000}?<\/h1\s*>/i;
const SWITCH_DESCRIPTION_END_RX = /<div\b[^>]*\bid\s*=\s*(["'])mg_footer\1[^>]*>/i;

/**
 * Read the vacancy-only portion of Switch's custom Umantis template.
 *
 * The employer introduction sits before the vacancy title and contact,
 * application and legal chrome sit under `#mg_footer`. Both boundaries are
 * required so a changed or partial response remains fail-closed.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractRecruitingapp2563Description(html = '') {
  const source = String(html || '');
  const start = SWITCH_DESCRIPTION_START_RX.exec(source);
  if (!start) return '';
  const tail = source.slice(start.index + start[0].length);
  const end = SWITCH_DESCRIPTION_END_RX.exec(tail);
  if (!end) return '';
  return normalizeSpace(stripHtml(tail.slice(0, end.index)));
}

/**
 * Recover Switch's explicit single-city title suffix as source-backed detail
 * evidence. This deliberately does not infer a location from arbitrary prose
 * or from the employer's registered address.
 *
 * @param {string} title
 * @returns {{ location: string, addressLocality: string, addressCountry: string }|null}
 */
export function extractRecruitingapp2563TitleLocation(title = '') {
  const normalizedTitle = normalizeSpace(title);
  const cityOccurrences = normalizedTitle.match(SWITCH_SUPPORTED_CITY_RX) || [];
  if (cityOccurrences.length !== 1) return null;
  const match = SWITCH_SINGLE_CITY_TITLE_RX.exec(normalizedTitle);
  if (!match) return null;
  const location = normalizeSpace(match[1]);
  const candidate = { location, addressLocality: location, addressCountry: 'CH' };
  return resolveDetailOrListingSwissGeography({}, candidate).geography
    ? candidate
    : null;
}

/**
 * Detail extractor for Switch's title-backed workplace field.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ recordUrl?: string }} [opts]
 */
export function extractRecruitingapp2563DetailFields(html = '', pageUrl = '', opts = {}) {
  const genericDetail = extractDetailFields(html, pageUrl, opts);
  const umantisDetail = extractUmantisDetailFields(html);
  const switchDescription = extractRecruitingapp2563Description(html);
  const detail = {
    ...genericDetail,
    description: genericDetail.description || umantisDetail.description || switchDescription,
  };
  const renderedTitle = stripHtml(/<h1\b[^>]*>([\s\S]{0,1000}?)<\/h1>/i.exec(html)?.[1] || '');
  const detailTitle = normalizeSpace(detail.title);
  const normalizedRenderedTitle = normalizeSpace(renderedTitle);
  const titleSourcesAgree = !detailTitle || !normalizedRenderedTitle
    || normalize(detailTitle) === normalize(normalizedRenderedTitle);
  const titleForLocation = titleSourcesAgree ? detailTitle || normalizedRenderedTitle : '';
  const location = extractRecruitingapp2563TitleLocation(titleForLocation);
  const alternativeLocation = location
    ? null
    : extractUmantisTitleAlternativeLocationEvidence(titleForLocation);

  // The shared Umantis extractor keeps every explicit alternative and projects
  // the first one for the site's singular job schema. Reuse that same evidence
  // on the detail page so a generic employer HQ cannot veto a vacancy title
  // that names two verified Swiss workplaces. A foreign or otherwise
  // conflicting structured detail candidate still wins as a fail-closed veto.
  if (alternativeLocation) {
    const genericLocationDecision = resolveDetailOrListingSwissGeography(detail, {});
    if (!genericLocationDecision.explicitlyForeign) {
      return {
        ...detail,
        location: alternativeLocation.location,
        addressLocality: alternativeLocation.addressLocality,
        addressRegion: alternativeLocation.addressRegion,
        addressCountry: alternativeLocation.addressCountry,
        postalCode: alternativeLocation.postalCode,
        streetAddress: alternativeLocation.streetAddress,
        locationCandidates: alternativeLocation.locationCandidates,
      };
    }
  }

  if (!location) {
    const genericLocationPresent = Boolean(detail.location)
      || Boolean(detail.addressCountry)
      || (Array.isArray(detail.locationCandidates) && detail.locationCandidates.length > 0);
    if (!genericLocationPresent) return detail;

    // The generic Umantis candidate is not trustworthy for this tenant when
    // the title does not prove one city. Block it explicitly so the shared
    // resolver cannot fall back to the employer HQ or a conflicting listing
    // candidate and publish an invented workplace.
    return {
      ...detail,
      location: '',
      addressCountry: '',
      locationCandidates: [],
      locationGateRejected: true,
    };
  }

  // A generic Umantis address can be the employer's HQ (historically Lugano),
  // not this vacancy's workplace. The explicit single-city title is stronger
  // source evidence, so replace the generic candidate rather than merge it.
  return {
    ...detail,
    location: location.location,
    addressCountry: location.addressCountry,
    locationCandidates: [location],
  };
}

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Switch Bewerbermanagement Stellen.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRecruitingapp2563Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RECRUITINGAPP_2563_KEY ||
    key.startsWith('recruitingapp-2563') ||
    company.includes('switch bewerbermanagement stellen') ||
    url.includes('recruitingapp-2563.umantis.com')
  );
}

/**
 * Validate that a URL belongs to Switch Bewerbermanagement Stellen's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'recruitingapp-2563.umantis.com' || host.endsWith('.recruitingapp-2563.umantis.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetcher guidato dalla spec ───────────────────────────────
 * Spec: data/prospector/crawlers/{key}.json — seed, modalita' di estrazione e
 * template degli URL di dettaglio, appresi dalla pagina reale.
 */
async function fetchJobListings(runtime = {}) {
  return runUmantisSpecWithEmptyProof(RECRUITINGAPP_2563_KEY, {
    ...runtime,
    detailExtractor: extractRecruitingapp2563DetailFields,
  });
}

/**
 * Fetch all Switch Bewerbermanagement Stellen jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRecruitingapp2563Jobs(runtime = {}) {
  console.log(`🔍 Fetching Switch Bewerbermanagement Stellen jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings(runtime);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return umantisAuthoritativeEmptyOrNull(listings, RECRUITINGAPP_2563_COMPANY_NAME) || [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  let geoEligible = 0;
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    if (!descriptionText) continue;

    // Every non-geographic gate is behind us: title and description are
    // fully extracted, so only the location can still exclude this listing.
    // Counting here — and not `listings.length` — is what makes the count
    // mean what autoFilteredEmpty claims it means (see note below).
    geoEligible += 1;

    // Umantis may expose alternative workplaces as separate source-backed
    // candidates. Resolve the full listing record so this parser keeps the
    // shared fail-closed multi-location decision instead of reducing it to
    // the single display `listing.location` field.
    const geographyDecision = resolveDetailOrListingSwissGeography({}, listing);
    const geography = sourceBackedSwissGeographyFields(listing, geographyDecision.geography);
    if (!geography) continue;
    const { location, canton, addressLocality, addressRegion, addressCountry } = geography;
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} recruitingapp-2563 ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `recruitingapp-2563-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RECRUITINGAPP_2563_COMPANY_NAME,
      companyKey: RECRUITINGAPP_2563_KEY,
      companyDomain: RECRUITINGAPP_2563_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Switch Bewerbermanagement Stellen Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: normalizeSpace(addressLocality || listing.addressLocality),
      addressRegion: normalizeSpace(addressRegion || listing.addressRegion || canton),
      addressCountry: normalizeSpace(addressCountry || "CH"),
      country: normalizeSpace(addressCountry || "CH"),
      ...(listing.postalCode ? { postalCode: normalizeSpace(listing.postalCode) } : {}),
      ...(listing.streetAddress ? { streetAddress: normalizeSpace(listing.streetAddress) } : {}),
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Altro', // TODO: Set appropriate sector
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, listing),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Switch Bewerbermanagement Stellen jobs discovered: ${jobs.length}`);
  // Geo-eligible candidate count (issue #5945, mirrors kudelski-nagra) — lets
  // the crawler-template pipeline report "found N listings, 0 Swiss after
  // filtering" as healthy instead of broken (check-crawler-health.mjs
  // autoFilteredEmpty), which a bare 3-run empty streak cannot distinguish
  // from a selector break.
  //
  // This counts listings that cleared EVERY non-geographic gate, not
  // `listings.length`. autoFilteredEmpty (`discovered > 0 && written === 0`)
  // asserts that the location filter alone emptied the run, so a listing
  // dropped for a missing title/description must NOT be counted here: doing
  // so would report a crawler whose detail extraction broke as healthy.
  //
  // Non-enumerable (repo idiom: ocst, chicco-doro, cippatrasporti, ipersonal):
  // the crawler-template reader at scripts/lib/crawler-template.mjs reads it
  // as a plain property, but an enumerable own property would leak into
  // deep-equality contracts like `resolves.toEqual([])`.
  Object.defineProperty(jobs, 'discoveredCount', {
    value: geoEligible,
    enumerable: false,
  });
  return jobs;
}

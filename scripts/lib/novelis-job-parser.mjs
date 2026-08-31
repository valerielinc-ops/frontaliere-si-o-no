#!/usr/bin/env node
/**
 * Novelis job parser — Fetcher and job builder.
 *
 * Source: https://jobs-novelis.icims.com/jobs/search?ss=1&searchLocation=13577--
 * (Switzerland-only facet on Novelis's iCIMS career portal)
 *
 * ── Root cause (#3797) ──────────────────────────────────────────────────
 * The old seed hit the Workday JSON API at
 * novelis.wd5.myworkdayjobs.com/wday/cxs/novelis/NovelisExternalCareerSite —
 * confirmed dead: both the API (HTTP 422) and the public Workday site itself
 * (HTTP 500) are gone. Novelis migrated its careers portal to iCIMS
 * (jobs-novelis.icims.com); novelis.com/careers/ now links there directly.
 * The iCIMS "in_iframe=1" search view server-renders job cards (no JS
 * execution required) and supports a native `searchLocation` facet — the
 * "Switzerland" option's value (13577--) was found in the rendered
 * <select name="searchLocation"> on the search page and returns Swiss
 * postings directly, without any client-side country filtering.
 *
 * Confirmed live: 11 Swiss postings (9 in CH-VS-Sierre — Novelis's main
 * Valais rolling/recycling plant — and 2 in CH-ZH-Küsnacht, a Switzerland
 * corporate-function office).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllNovelisJobs()  — Fetch and parse all jobs
 *   - isNovelisJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { inferAnyCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const NOVELIS_KEY = 'novelis';
export const NOVELIS_COMPANY_NAME = 'Novelis';
export const NOVELIS_COMPANY_DOMAIN = 'novelis.com';

const ICIMS_HOST = 'jobs-novelis.icims.com';
// Switzerland facet value, read off the rendered <select name="searchLocation">
// on the iCIMS search page.
const CAREER_URL = `https://${ICIMS_HOST}/jobs/search?ss=1&searchLocation=13577--&in_iframe=1`;

const HQ = getCompanyDefaults('novelis');

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Novelis.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isNovelisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === NOVELIS_KEY ||
    key.startsWith('novelis') ||
    company.includes('novelis') ||
    url.includes('novelis.com') ||
    url.includes('novelis.icims.com')
  );
}

/**
 * Validate that a URL belongs to Novelis's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'novelis.com' ||
      host.endsWith('.novelis.com') ||
      host.endsWith('novelis.icims.com')
    );
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
  if (/\b(hr|human|risorse|personal|stagiaire.*ressources)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel|60%-80|stagiaire|internship)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── iCIMS Listing + Detail Parsing ──────────────────────────── */

/**
 * Parse the iCIMS "in_iframe=1" search results page. Server-rendered, no JS
 * execution required — each job is an `<li class="iCIMS_JobCardItem">` with
 * a title link and a "Job Locations" field formatted as "CC-RR-City" (e.g.
 * "CH-VS-Sierre") or "CC-City" for countries without a region code.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const cards = document.querySelectorAll('li.iCIMS_JobCardItem');
  const jobs = [];

  for (const card of cards) {
    const anchor = card.querySelector('a.iCIMS_Anchor');
    const href = anchor?.getAttribute('href') || '';
    if (!href) continue;
    const url = href.startsWith('http') ? href : `https://${ICIMS_HOST}${href.startsWith('/') ? '' : '/'}${href}`;

    const titleEl = card.querySelector('h3');
    const title = normalizeSpace(titleEl?.textContent || '');
    if (!title) continue;

    const leftDiv = card.querySelector('.header.left');
    const locSpans = leftDiv ? [...leftDiv.querySelectorAll('span')] : [];
    const locSpan = locSpans.find((s) => !s.classList.contains('sr-only'));
    const rawLocation = normalizeSpace(locSpan?.textContent || '');

    jobs.push({ title, url, rawLocation });
  }

  return jobs;
}

/**
 * Parse a "CC-RR-City" or "CC-City" location code into { city, canton }.
 * Only Swiss ("CH-...") codes are expected here since the listing page is
 * already filtered to the Switzerland facet, but we stay defensive.
 */
function parseLocationCode(rawLocation = '') {
  const parts = String(rawLocation).split('-').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: '', canton: '' };
  if (parts.length >= 3 && /^[a-z]{2}$/i.test(parts[1])) {
    // "CH-VS-Sierre" (region code present) — validate against the real
    // canton registry before trusting it; a shape-only check would let a
    // malformed/non-Swiss 2-letter token through as a fabricated canton.
    const city = parts.slice(2).join('-');
    const canton = normalizeCantonCode(parts[1]) || inferAnyCanton(city) || '';
    return { city, canton };
  }
  // "CH-City" (no region code) — infer canton from the city name.
  const city = parts.slice(1).join('-') || parts[0];
  return { city, canton: inferAnyCanton(city) || '' };
}

/**
 * Fetch and parse a single job's detail page for its full description.
 */
async function fetchJobDescription(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl, { timeoutMs: 20000 });
    const { document } = new JSDOM(html).window;
    const container = document.querySelector('.iCIMS_JobContent');
    return stripHtml(container?.innerHTML || '');
  } catch (err) {
    console.warn(`  ⚠️ Failed to fetch job detail ${detailUrl}: ${err.message}`);
    return '';
  }
}

/* ── Main Fetch Function ─────────────────────────────────── */

/**
 * Fetch all Novelis Swiss jobs from the iCIMS career portal.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllNovelisJobs() {
  console.log(`🔍 Fetching Novelis jobs from iCIMS`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let listings = [];
  try {
    const html = await fetchHtml(CAREER_URL, { timeoutMs: 25000 });
    listings = parseListingPage(html);
  } catch (err) {
    throw new Error(`Novelis: failed to fetch the careers page: ${err.message}`, { cause: err });
  }

  if (!listings.length) {
    console.warn('⚠️ No Swiss job listings returned from iCIMS.');
    return [];
  }

  console.log(`  📋 Swiss job listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const { city, canton: parsedCanton } = parseLocationCode(listing.rawLocation);
    const canton = parsedCanton || HQ?.canton || 'VS';
    const location = city || HQ?.city || 'Sierre';

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const descriptionText = await fetchJobDescription(listing.url);

    const descText = descriptionText
      ? `${descriptionText}\n\nNovelis is the world leader in aluminium rolling and recycling, with a major production facility in Sierre (Valais), Switzerland. The company produces flat-rolled aluminium products for the automotive, beverage can, and specialty markets.`.trim()
      : `${listing.title} position at Novelis in ${location}, Switzerland.\n\nNovelis is the world leader in aluminium rolling and recycling, with a major production facility in Sierre (Valais), Switzerland. The company produces flat-rolled aluminium products for the automotive, beverage can, and specialty markets.`.trim();

    const sourceLang = detectLang(descriptionText || listing.title, 'en');
    const jobSlug = slugify(`${listing.title} novelis ch`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${listing.title} ${descriptionText}`);

    jobs.push({
      id: `novelis-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: NOVELIS_COMPANY_NAME,
      companyKey: NOVELIS_KEY,
      companyDomain: NOVELIS_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description: descText,
      descriptionByLocale: { [sourceLang]: descText },
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      location,
      canton,
      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: /sierre/i.test(location) ? (HQ?.postalCode || '3960') : '',
      category: detectCategory(listing.title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(listing.title),
      sector: 'Metallurgia / Alluminio',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      url: listing.url,
      applyUrl: listing.url,
      source: 'Novelis Dedicated Parser (iCIMS)',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Novelis jobs discovered (Switzerland only): ${jobs.length}`);
  return jobs;
}

/**
 * Air Zermatt AG — Job listing parser
 *
 * Career page: https://www.air-zermatt.ch/jobs
 *   (also accessible at /de/service/offene-stellen)
 *
 * The page uses a CMS listing module with MixItUp filtering.
 * Each job is in a `.listing_entry` div inside `div#mixItUp`.
 * Detail pages are at /de/service/offene-stellen/{slug}-{id}
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.air-zermatt.ch';
const CAREERS_URL = 'https://www.air-zermatt.ch/jobs';
const HQ = getCompanyDefaults('air-zermatt');

export const AIR_ZERMATT_KEY = 'air-zermatt';
export const AIR_ZERMATT_COMPANY_NAME = 'Air Zermatt AG';
export const AIR_ZERMATT_COMPANY_DOMAIN = 'air-zermatt.ch';

export const MIN_DESC_LENGTH = 100;

/* ── Job identification ───────────────────────────────────── */

export function isAirZermattJob(job = {}) {
  const key = String(job?.companyKey || '').trim().toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === AIR_ZERMATT_KEY ||
    company.includes('air zermatt') ||
    company.includes('air-zermatt') ||
    url.includes('air-zermatt.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.includes('air-zermatt.ch');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Air Zermatt jobs listing page.
 * Returns an array of { id, title, url, snippet, location } objects.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  const entries = document.querySelectorAll('.listing_entry');
  for (const entry of entries) {
    const entryId = entry.getAttribute('data-entry-id') || '';
    if (!entryId || seen.has(entryId)) continue;

    const titleEl = entry.querySelector('h2.listing-title a, h2 a, .listing-title a');
    const title = normalizeSpace(titleEl?.textContent || '');
    if (!title || title.length < 3) continue;

    const href = titleEl?.getAttribute('href') || '';
    const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

    const descEl = entry.querySelector('.listing-content-text');
    const snippet = normalizeSpace(descEl?.textContent || '');

    // Extract location from bold text in description
    let location = 'Raron';
    const boldEls = descEl?.querySelectorAll('strong, b') || [];
    for (const b of boldEls) {
      const text = normalizeSpace(b.textContent || '');
      if (/raron|zermatt|visp|brig/i.test(text)) {
        location = text.replace(/[.,;]+$/, '').trim();
        break;
      }
    }

    seen.add(entryId);
    jobs.push({ id: entryId, title, url, snippet, location });
  }

  return jobs;
}

/**
 * Parse a detail page for full job description.
 */
function parseDetailPage(html = '') {
  if (!html) return '';

  const { document } = new JSDOM(html).window;

  const BODY_SELECTORS = [
    '.listing-content-text',
    '.listing_entry .content',
    '.detail-content',
    '#content .content',
    'article',
    'main',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const candidate = stripHtml(el.innerHTML || '');
    if (candidate.length > body.length) body = candidate;
    if (candidate.length >= MIN_DESC_LENGTH) break;
  }

  if (body.length < MIN_DESC_LENGTH) {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll('div, section, article')) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best && bestLen > body.length) {
      body = stripHtml(best.innerHTML || '');
    }
  }

  return body;
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/pilot|flug|luft|heli/i.test(t)) return 'aviation';
  if (/mechanik|techniker|avionik|wartung/i.test(t)) return 'engineering';
  if (/rettung|rescue|paramedic|sanitä/i.test(t)) return 'rescue';
  if (/marketing|kommunikation|media/i.test(t)) return 'marketing';
  if (/admin|office|sekretär/i.test(t)) return 'admin';
  if (/lehr|ausbildung|apprent|stipend/i.test(t)) return 'apprenticeship';
  if (/training|instructor|coach/i.test(t)) return 'training';
  return 'general';
}

function detectExperienceLevel(title = '') {
  if (/lehr|ausbildung|intern|junior|entry|stage|apprent|stipend/i.test(title)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chef/i.test(title)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', description = '') {
  const combined = `${title} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Air Zermatt jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllAirZermattJobs() {
  console.log(`  Fetching Air Zermatt jobs from ${CAREERS_URL}`);

  const html = await fetchHtml(CAREERS_URL, { timeoutMs: 25000 });
  const listings = parseListingPage(html);
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    let description = listing.snippet || '';
    if (listing.url) {
      try {
        const detailHtml = await fetchHtml(listing.url);
        const detailBody = parseDetailPage(detailHtml);
        if (detailBody && detailBody.length > description.length) {
          description = detailBody;
        }
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    const location = listing.location || 'Raron';
    const sourceLang = detectLang(listing.title, 'de');
    const jobSlug = buildJobSlug(`${listing.title} ${location}`, 'air-zermatt');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${AIR_ZERMATT_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: AIR_ZERMATT_COMPANY_NAME,
      companyKey: AIR_ZERMATT_KEY,
      companyDomain: AIR_ZERMATT_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton: /zermatt/i.test(location) ? 'VS' : HQ.canton,
      addressLocality: location.split('/')[0].trim(),
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Aviazione / Servizi di soccorso',
      contract: inferEmploymentType(listing.title, description) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: inferEmploymentType(listing.title, description),
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Air Zermatt Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Air Zermatt jobs discovered: ${jobs.length}`);
  return jobs;
}

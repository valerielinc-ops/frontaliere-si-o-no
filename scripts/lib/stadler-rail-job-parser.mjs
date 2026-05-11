#!/usr/bin/env node
/**
 * Stadler Rail job parser — Fetcher and job builder.
 *
 * Source: https://www.stadlerrail.com/en/careers/open-positions-it
 *
 * The listing page is a Next.js RSC app that renders job cards client-side.
 * Each job is an <a> linking to jobs.stadlerrail.ch with an <h4> title and
 * <p> location. The RSC flight data is embedded in the initial HTML response,
 * so we parse it via regex from the raw HTML.
 *
 * Detail pages are at jobs.stadlerrail.ch/posizioni-aperte/{dept}/{slug}/{uuid}
 * powered by Prospective.ch career center.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllStadlerRailJobs()  — Fetch and parse all jobs
 *   - isStadlerRailJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.stadlerrail.com';
const CAREERS_URL = 'https://www.stadlerrail.com/en/careers/open-positions-it';
const HQ = getCompanyDefaults('stadler-rail');

export const STADLER_RAIL_KEY = 'stadler-rail';
export const STADLER_RAIL_COMPANY_NAME = 'Stadler Rail';
export const STADLER_RAIL_COMPANY_DOMAIN = 'stadlerrail.com';

export const MIN_DESC_LENGTH = 100;

/**
 * Swiss location keywords used to filter only Swiss-based jobs.
 * The listing page contains ~370 jobs worldwide; we only want Swiss ones.
 */
const SWISS_LOCATION_RE = /schweiz|svizzera|switzerland|suisse/i;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Stadler Rail.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isStadlerRailJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STADLER_RAIL_KEY ||
    key.startsWith('stadler-rail') ||
    company.includes('stadler rail') ||
    url.includes('stadlerrail.com')
  );
}

/**
 * Validate that a URL belongs to Stadler Rail's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'stadlerrail.com' || host.endsWith('.stadlerrail.com');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Stadler Rail listing page.
 * The page is a Next.js RSC app. The initial HTML contains RSC flight data
 * with job links rendered as <a href="https://jobs.stadlerrail.ch/..."> elements.
 * Each link has an <h4> for the title and a <p> for the location.
 *
 * Returns an array of { title, url, location, city } objects.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Job links point to jobs.stadlerrail.ch with posizioni-aperte path
  const links = document.querySelectorAll('a[href*="jobs.stadlerrail.ch"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    if (!href.includes('posizioni-aperte')) continue;
    if (seen.has(href)) continue;

    const h4 = link.querySelector('h4');
    const title = normalizeSpace(h4?.textContent || '');
    if (!title || title.length < 3) continue;

    const pEl = link.querySelector('p');
    const locationText = normalizeSpace(pEl?.textContent || '');

    // Only include Swiss jobs
    if (!SWISS_LOCATION_RE.test(locationText)) continue;

    seen.add(href);

    // Extract city from location (format: "City, Schweiz" or "City, Switzerland")
    const city = locationText.replace(/,\s*(schweiz|svizzera|switzerland|suisse)$/i, '').trim();

    jobs.push({
      title,
      url: href.startsWith('http') ? href : `https://${href}`,
      location: locationText,
      city: city || HQ.city,
    });
  }

  return jobs;
}

/**
 * Parse a Stadler Rail detail page for full description.
 * Detail pages are at jobs.stadlerrail.ch — Prospective.ch career center.
 * These are also JS-rendered SPAs, so we extract what we can from the HTML.
 */
function parseDetailPage(html = '') {
  if (!html) return '';

  const { document } = new JSDOM(html).window;

  const BODY_SELECTORS = [
    '.job-detail',
    '.content',
    'article',
    'main',
    '#content',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const candidate = stripHtml(el.innerHTML || '');
    if (candidate.length > body.length) body = candidate;
    if (candidate.length >= MIN_DESC_LENGTH) break;
  }

  // Fallback: largest text block
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
  if (/ingegner|engineer|entwickl/i.test(t)) return 'engineering';
  if (/techni|tecnic|mecanic|elektr|install|inbetrieb|wartung/i.test(t)) return 'engineering';
  if (/admin|segret|contab|buchhalt|account|kauffrau|kaufmann/i.test(t)) return 'admin';
  if (/vendita|sales|verkauf|einkauf|commerce|procurement/i.test(t)) return 'sales';
  if (/logist|magazz|lager|warehouse|supply/i.test(t)) return 'logistics';
  if (/produz|operat|operator|manufactur|montag|schweis|fertigung/i.test(t)) return 'production';
  if (/qualit|qa|qc|quality|prüf/i.test(t)) return 'quality';
  if (/\bit\b|software|develop|programm|sap|data|cyber/i.test(t)) return 'technology';
  if (/hr\b|human|risorse|personal|recruit/i.test(t)) return 'hr';
  if (/market|kommunik|comunicaz/i.test(t)) return 'marketing';
  if (/finanz|finance|financ|controll/i.test(t)) return 'finance';
  if (/legal|giurid|recht|compliance/i.test(t)) return 'legal';
  if (/projekt|project|programm/i.test(t)) return 'project-management';
  if (/lehr|ausbildung|apprent|praktik|dual/i.test(t)) return 'apprenticeship';
  return 'general';
}

function detectExperienceLevel(title = '') {
  if (/lehr|ausbildung|intern|junior|entry|stage|apprent|praktik|dual/i.test(title)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chef|teamleit|gruppenleiter/i.test(title)) return 'SENIOR';
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

/**
 * Infer the canton from the city name in the location text.
 */
function inferCanton(city = '') {
  const c = city.toLowerCase().trim();
  if (/bellinzona/i.test(c)) return 'TI';
  if (/bussnang|erlen|frauenfeld|amriswil/i.test(c)) return 'TG';
  if (/winterthur|wallisellen|zürich/i.test(c)) return 'ZH';
  if (/st\.?\s*margrethen/i.test(c)) return 'SG';
  if (/olten/i.test(c)) return 'SO';
  if (/biel|bienne/i.test(c)) return 'BE';
  if (/aigle|vufflens/i.test(c)) return 'VD';
  if (/baar|luzern/i.test(c)) return 'ZG';
  if (/interlaken/i.test(c)) return 'BE';
  return HQ.canton;
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Stadler Rail jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllStadlerRailJobs() {
  console.log(`  Fetching Stadler Rail jobs from ${CAREERS_URL}`);
  let html = '';
  try {
    html = await fetchHtml(CAREERS_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
  const listings = parseListingPage(html);
  console.log(`  Swiss jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    // Detail pages are Prospective.ch SPAs — JS-rendered, so fetchHtml
    // gets minimal content. We try anyway and use a fallback description.
    let description = '';
    if (listing.url) {
      try {
        const detailHtml = await fetchHtml(listing.url, { timeoutMs: 15000 });
        description = parseDetailPage(detailHtml);
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    // Fallback description if detail page didn't yield enough content
    if (!description || description.length < MIN_DESC_LENGTH) {
      description = `${listing.title} — Stadler Rail, ${listing.city}`;
    }

    const city = listing.city || HQ.city;
    const canton = inferCanton(city);
    const sourceLang = detectLang(listing.title, 'de');
    const jobSlug = buildJobSlug(`${listing.title} ${city}`, 'stadler-rail');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, description);

    jobs.push({
      id: `${STADLER_RAIL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STADLER_RAIL_COMPANY_NAME,
      companyKey: STADLER_RAIL_KEY,
      companyDomain: STADLER_RAIL_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: canton === 'TI' ? HQ.postalCode : '',
      category: detectCategory(listing.title),
      sector: 'Trasporti / Costruzione veicoli ferroviari',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Stadler Rail Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Stadler Rail jobs discovered: ${jobs.length}`);
  return jobs;
}

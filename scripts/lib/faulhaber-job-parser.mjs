#!/usr/bin/env node
/**
 * Faulhaber job parser — Fetcher and job builder.
 *
 * Source: https://jobs.faulhaber.com/HPv3.Jobs/faulhaber/stellenangebote
 *
 * HPv3.Jobs (HR4YOU) Vue.js portal. Job tiles are rendered client-side in:
 *   .joboffer-tile > div[data-v-*] > .tile-body containing:
 *     h3.tile-headline > a[href*="stellenangebot/{id}"] — title + detail link
 *     .tag with fa-map-marker icon — location
 *     .tag with fa-briefcase icon — department
 *
 * Since the page is a Vue.js SPA, the initial HTML may not contain job data.
 * The HPv3 portal often also serves the tile HTML server-side for SEO,
 * but if not, we fall back to the detail page links found in the HTML.
 *
 * We filter for CH - Croglio (Ticino) locations only.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFaulhaberJobs()  — Fetch and parse all jobs
 *   - isFaulhaberJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://jobs.faulhaber.com';
const CAREERS_URL = 'https://jobs.faulhaber.com/HPv3.Jobs/faulhaber/stellenangebote';
const HQ = getCompanyDefaults('faulhaber');

export const FAULHABER_KEY = 'faulhaber';
export const FAULHABER_COMPANY_NAME = 'Faulhaber';
export const FAULHABER_COMPANY_DOMAIN = 'faulhaber.com';

export const MIN_DESC_LENGTH = 100;

/** Only keep Swiss (Croglio) jobs */
const SWISS_LOCATION_RE = /\bCH\b|croglio|schweiz|svizzera|switzerland/i;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Faulhaber.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFaulhaberJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FAULHABER_KEY ||
    key.startsWith('faulhaber') ||
    company.includes('faulhaber') ||
    url.includes('faulhaber.com')
  );
}

/**
 * Validate that a URL belongs to Faulhaber's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'faulhaber.com' || host.endsWith('.faulhaber.com');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Faulhaber HPv3 listing page.
 * Job tiles are in .joboffer-tile divs:
 *   h3.tile-headline > a — title + detail link
 *   .tag with .fa-map-marker — location
 *   .tag with .fa-briefcase — department
 *
 * The HPv3 Vue.js app may not render tiles in the initial HTML (SSR varies).
 * If tiles aren't present, we fall back to parsing <a> links with stellenangebot paths.
 *
 * Returns an array of { title, url, location, department } objects.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Parse .joboffer-tile cards (HPv3 SSR)
  const tiles = document.querySelectorAll('.joboffer-tile');
  for (const tile of tiles) {
    const titleLink = tile.querySelector('h3 a, .tile-headline a');
    if (!titleLink) continue;

    const title = normalizeSpace(titleLink.textContent || '');
    if (!title || title.length < 3) continue;

    let href = titleLink.getAttribute('href') || '';
    if (!href) continue;
    const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    if (seen.has(url)) continue;

    // Extract location from .tag with map-marker icon
    let location = '';
    let department = '';
    const tags = tile.querySelectorAll('.tag');
    for (const tag of tags) {
      const icon = tag.querySelector('i, .icon');
      const text = normalizeSpace(tag.querySelector('.text, span:last-child')?.textContent || tag.textContent || '');
      if (icon?.className?.includes('map-marker')) {
        location = text;
      } else if (icon?.className?.includes('briefcase')) {
        department = text;
      }
    }

    // Only keep Swiss (Croglio) jobs
    if (!SWISS_LOCATION_RE.test(location)) continue;

    seen.add(url);
    jobs.push({ title, url, location, department });
  }

  // Strategy 2: Fallback — parse <a> links with stellenangebot path
  if (jobs.length === 0) {
    const links = document.querySelectorAll('a[href*="stellenangebot"]');
    for (const link of links) {
      const title = normalizeSpace(link.textContent || '');
      if (!title || title.length < 5) continue;
      if (/job.?alert|subscribe|abonnieren/i.test(title)) continue;

      let href = link.getAttribute('href') || '';
      if (!href.includes('stellenangebot/')) continue;
      const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
      if (seen.has(url)) continue;
      seen.add(url);

      // We can't determine location from fallback links without tile context,
      // so include all and filter later from detail page content
      jobs.push({ title, url, location: '', department: '' });
    }
  }

  return jobs;
}

/**
 * Parse a Faulhaber detail page for description and location.
 * HPv3 detail pages have the job description in structured sections.
 */
function parseDetailPage(html = '') {
  if (!html) return { description: '', location: '' };

  const { document } = new JSDOM(html).window;

  // Extract location from meta or detail fields
  let location = '';
  const locationEls = document.querySelectorAll('.tag, .detail-field, [class*="location"]');
  for (const el of locationEls) {
    const text = normalizeSpace(el.textContent || '');
    if (SWISS_LOCATION_RE.test(text)) {
      location = text;
      break;
    }
  }

  // Extract description
  const BODY_SELECTORS = [
    '.job-description',
    '.detail-content',
    '.joboffer-detail',
    '.content',
    'article',
    'main',
    '#content',
  ];

  let body = '';
  for (const sel of BODY_SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const candidate = stripHtml(el.innerHTML || '');
      if (candidate.length > body.length) body = candidate;
    }
    if (body.length >= MIN_DESC_LENGTH) break;
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

  return { description: body, location };
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = `${title} ${department}`.toLowerCase();
  if (/ingegner|engineer|entwickl|r&d|research/i.test(t)) return 'engineering';
  if (/techni|tecnic|mecanic|elektr|maschinen|cnc/i.test(t)) return 'engineering';
  if (/produk|produzi|manufactur|fertigung/i.test(t)) return 'production';
  if (/logist|magazz|lager|warehouse|supply/i.test(t)) return 'logistics';
  if (/admin|segret|contab|buchhalt|account/i.test(t)) return 'admin';
  if (/vendita|sales|verkauf|inside sales/i.test(t)) return 'sales';
  if (/qualit|qa|qc|quality|prüf/i.test(t)) return 'quality';
  if (/\bit\b|software|develop|programm|data/i.test(t)) return 'technology';
  if (/hr\b|human|risorse|personal/i.test(t)) return 'hr';
  if (/lehr|ausbildung|apprent|praktik|dual|studium|thesis/i.test(t)) return 'apprenticeship';
  return 'general';
}

function detectExperienceLevel(title = '') {
  if (/lehr|ausbildung|intern|junior|entry|stage|apprent|praktik|dual|studium|thesis|schüler/i.test(title)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chef|teamleit|gruppenleiter/i.test(title)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', description = '') {
  const combined = `${title} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Faulhaber jobs. Returns ParsedJob[] (source locale only).
 * Filters for CH - Croglio (Ticino) positions only.
 */
export async function fetchAllFaulhaberJobs() {
  console.log(`  Fetching Faulhaber jobs from ${CAREERS_URL}`);
  let html = '';
  try {
    html = await fetchHtml(CAREERS_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
  let listings = parseListingPage(html);
  console.log(`  Swiss jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    let description = '';
    let detailLocation = listing.location;

    if (listing.url) {
      try {
        const detailHtml = await fetchHtml(listing.url, { timeoutMs: 15000 });
        const detail = parseDetailPage(detailHtml);
        description = detail.description;
        if (!detailLocation && detail.location) detailLocation = detail.location;
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    // If we got no location from listing and detail didn't confirm Swiss, skip
    if (!listing.location && !SWISS_LOCATION_RE.test(detailLocation)) continue;

    // Fallback description
    if (!description || description.length < MIN_DESC_LENGTH) {
      description = `${listing.title} — Faulhaber, Croglio TI`;
      if (listing.department) description += `. Abteilung: ${listing.department}`;
    }

    const sourceLang = detectLang(listing.title, 'de');
    const jobSlug = buildJobSlug(`${listing.title} Croglio`, 'faulhaber');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, description);

    jobs.push({
      id: `${FAULHABER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FAULHABER_COMPANY_NAME,
      companyKey: FAULHABER_KEY,
      companyDomain: FAULHABER_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Croglio',
      canton: HQ.canton,
      addressLocality: 'Croglio',
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title, listing.department),
      sector: 'Meccanica di precisione / Motori elettrici',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Faulhaber Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Faulhaber jobs discovered: ${jobs.length}`);
  return jobs;
}

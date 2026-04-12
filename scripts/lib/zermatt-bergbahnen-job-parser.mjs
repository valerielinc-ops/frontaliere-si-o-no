#!/usr/bin/env node
/**
 * Zermatt Bergbahnen job parser — Fetcher and job builder.
 *
 * Source: https://www.matterhornparadise.ch/de/ueber-uns/job-und-karriere
 *
 * Pimcore CMS. Job listings are card items with:
 *   .card-item__body containing:
 *     .card-item__top-title  — department
 *     h3.card-item__title > a.stretch-link__link — job title + link
 *     .card-item__tag-list > .card-item__tag-list-item — tags (Vollzeit, Befristet, etc.)
 * Detail pages at /de/ueber-uns/job-und-karriere/{slug}_job_{id}
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllZermattBergbahnenJobs()  — Fetch and parse all jobs
 *   - isZermattBergbahnenJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.matterhornparadise.ch';
const CAREERS_URL = 'https://www.matterhornparadise.ch/de/ueber-uns/job-und-karriere';
const HQ = getCompanyDefaults('zermatt-bergbahnen');

export const ZERMATT_BERGBAHNEN_KEY = 'zermatt-bergbahnen';
export const ZERMATT_BERGBAHNEN_COMPANY_NAME = 'Zermatt Bergbahnen';
export const ZERMATT_BERGBAHNEN_COMPANY_DOMAIN = 'matterhornparadise.ch';

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Zermatt Bergbahnen.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isZermattBergbahnenJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ZERMATT_BERGBAHNEN_KEY ||
    key.startsWith('zermatt-bergbahnen') ||
    company.includes('zermatt bergbahnen') ||
    url.includes('matterhornparadise.ch')
  );
}

/**
 * Validate that a URL belongs to Zermatt Bergbahnen's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'matterhornparadise.ch' || host.endsWith('.matterhornparadise.ch');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Zermatt Bergbahnen careers listing page.
 * Jobs are in .card-item__body containers with:
 *   .card-item__top-title — department name
 *   h3.card-item__title > a.stretch-link__link — title + href
 *   .card-item__tag-list-item — tags (Vollzeit/Teilzeit, Befristet/Unbefristet, Jobs/Lehrstellen)
 *
 * Returns an array of { title, url, department, tags } objects.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Primary strategy: card items
  const cards = document.querySelectorAll('.card-item__body');
  for (const card of cards) {
    const titleLink = card.querySelector('h3 a, h3.card-item__title a, .card-item__title a');
    if (!titleLink) continue;

    const title = normalizeSpace(titleLink.textContent || '');
    if (!title || title.length < 3) continue;

    let href = titleLink.getAttribute('href') || '';
    if (!href) continue;
    const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const deptEl = card.querySelector('.card-item__top-title');
    const department = normalizeSpace(deptEl?.textContent || '');

    const tagEls = card.querySelectorAll('.card-item__tag-list-item');
    const tags = [...tagEls].map(t => normalizeSpace(t.textContent || '')).filter(Boolean);

    jobs.push({ title, url, department, tags });
  }

  // Fallback strategy: look for links with _job_ in href
  if (jobs.length === 0) {
    const jobLinks = document.querySelectorAll('a[href*="_job_"]');
    for (const link of jobLinks) {
      const title = normalizeSpace(link.textContent || '');
      if (!title || title.length < 5) continue;

      let href = link.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
      if (seen.has(url)) continue;
      seen.add(url);

      jobs.push({ title, url, department: '', tags: [] });
    }
  }

  return jobs;
}

/**
 * Parse a Zermatt Bergbahnen job detail page for full description.
 */
function parseDetailPage(html = '') {
  if (!html) return '';

  const { document } = new JSDOM(html).window;

  const BODY_SELECTORS = [
    '.content-block',
    '.ce-bodytext',
    '.frame-type-text',
    'article',
    '.content-main',
    '#content',
    'main',
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

  return body;
}

/* ── Category / Employment helpers ────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = `${title} ${department}`.toLowerCase();
  if (/techni|mechan|elektr|metallbau|seilbahn|maschinen/i.test(t)) return 'engineering';
  if (/\bit\b|informati|software|telekomm/i.test(t)) return 'technology';
  if (/market|sales|verkauf|berater/i.test(t)) return 'sales';
  if (/gastro|restaurant|service|küch|koch|chef de/i.test(t)) return 'hospitality';
  if (/admin|büro|office|sekretär/i.test(t)) return 'admin';
  if (/lehr|ausbildung|apprent/i.test(t)) return 'apprenticeship';
  if (/finan|buchhalt|controll/i.test(t)) return 'finance';
  if (/piste|patrol|rettung|sicher/i.test(t)) return 'operations';
  return 'tourism';
}

function detectExperienceLevel(title = '', tags = []) {
  const combined = `${title} ${tags.join(' ')}`;
  if (/lehr|ausbildung|intern|junior|entry|stage|apprent|praktik/i.test(combined)) return 'ENTRY';
  if (/senior|lead|head|director|manager|chef|teamleit|stv\./i.test(combined)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', tags = []) {
  const combined = `${title} ${tags.join(' ')}`;
  if (/teilzeit|part[- ]?time|tempo parziale/i.test(combined)) return 'PART_TIME';
  if (/vollzeit|full[- ]?time/i.test(combined)) return 'FULL_TIME';
  // Check percentage
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Zermatt Bergbahnen jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllZermattBergbahnenJobs() {
  console.log(`  Fetching Zermatt Bergbahnen jobs from ${CAREERS_URL}`);

  // SSL may have issues — set env var to allow self-signed certs
  const origTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  let html;
  try {
    html = await fetchHtml(CAREERS_URL, { timeoutMs: 25000 });
  } finally {
    // Restore original TLS setting
    if (origTls === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls;
    }
  }

  const listings = parseListingPage(html);
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    let description = '';
    if (listing.url) {
      try {
        // Detail pages may also have SSL issues
        const origTls2 = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        try {
          const detailHtml = await fetchHtml(listing.url, { timeoutMs: 15000 });
          description = parseDetailPage(detailHtml);
        } finally {
          if (origTls2 === undefined) {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
          } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = origTls2;
          }
        }
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    // Fallback description
    if (!description || description.length < MIN_DESC_LENGTH) {
      const parts = [listing.title, '— Zermatt Bergbahnen, Zermatt'];
      if (listing.department) parts.push(`Abteilung: ${listing.department}`);
      if (listing.tags.length) parts.push(listing.tags.join(', '));
      description = parts.join('. ');
    }

    const sourceLang = detectLang(listing.title, 'de');
    const jobSlug = buildJobSlug(`${listing.title} Zermatt`, 'zermatt-bergbahnen');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, listing.tags);

    jobs.push({
      id: `${ZERMATT_BERGBAHNEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ZERMATT_BERGBAHNEN_COMPANY_NAME,
      companyKey: ZERMATT_BERGBAHNEN_KEY,
      companyDomain: ZERMATT_BERGBAHNEN_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Zermatt',
      canton: HQ.canton,
      addressLocality: 'Zermatt',
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title, listing.department),
      sector: 'Turismo / Funivie',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title, listing.tags),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Zermatt Bergbahnen Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Zermatt Bergbahnen jobs discovered: ${jobs.length}`);
  return jobs;
}

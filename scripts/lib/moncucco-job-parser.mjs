#!/usr/bin/env node
/**
 * Gruppo Ospedaliero Moncucco job parser — Fetcher and job builder.
 *
 * Source: https://www.moncucco.ch/lavora-con-noi.php
 *
 * Simple static PHP page. Job listings are <a> cards, each containing:
 *   <h3>Job Title</h3>
 *   <p>Percentuale di impiego: 80-100%</p>
 *   <p>Disponibilità: Da convenire</p>
 * Detail pages are at https://www.moncucco.ch/{slug}.php5
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMoncuccoJobs()  — Fetch and parse all jobs
 *   - isMoncuccoJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const BASE_URL = 'https://www.moncucco.ch';
const CAREERS_URL = 'https://www.moncucco.ch/lavora-con-noi.php';
const HQ = getCompanyDefaults('moncucco');

export const MONCUCCO_KEY = 'moncucco';
export const MONCUCCO_COMPANY_NAME = 'Gruppo Ospedaliero Moncucco';
export const MONCUCCO_COMPANY_DOMAIN = 'moncucco.ch';

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Gruppo Ospedaliero Moncucco.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMoncuccoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MONCUCCO_KEY ||
    key.startsWith('moncucco') ||
    company.includes('gruppo ospedaliero moncucco') ||
    url.includes('moncucco.ch')
  );
}

/**
 * Validate that a URL belongs to Gruppo Ospedaliero Moncucco's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'moncucco.ch' || host.endsWith('.moncucco.ch');
  } catch {
    return false;
  }
}

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Moncucco careers listing page.
 * Jobs are <a> card links containing:
 *   <h3>Job Title</h3>
 *   <p>Percentuale di impiego: 80-100%</p>
 *   <p>Disponibilità: Da convenire</p>
 *
 * Returns an array of { title, url, percentage, availability } objects.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Find <a> links that contain <h3> headings (job cards)
  const allLinks = document.querySelectorAll('a[href]');
  for (const link of allLinks) {
    const h3 = link.querySelector('h3, h4');
    if (!h3) continue;

    const title = normalizeSpace(h3.textContent || '');
    if (!title || title.length < 3) continue;

    let href = link.getAttribute('href') || '';
    if (!href) continue;
    const url = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
    if (seen.has(url)) continue;
    seen.add(url);

    // Extract percentage and availability from <p> tags
    const paragraphs = link.querySelectorAll('p');
    let percentage = '';
    let availability = '';
    for (const p of paragraphs) {
      const text = normalizeSpace(p.textContent || '');
      if (/percentuale|impiego|%/i.test(text)) {
        percentage = text;
      } else if (/disponibilit/i.test(text)) {
        availability = text;
      }
    }

    jobs.push({ title, url, percentage, availability });
  }

  // Strategy 2: Fallback — look for h3 headings near links
  if (jobs.length === 0) {
    const headings = document.querySelectorAll('h3, h4');
    for (const h of headings) {
      const title = normalizeSpace(h.textContent || '');
      if (!title || title.length < 5) continue;

      // Look for a sibling or parent link
      const parent = h.closest('a') || h.parentElement?.closest('a');
      const link = parent || h.querySelector('a') || h.parentElement?.querySelector('a');
      if (!link) continue;

      let href = link.getAttribute('href') || '';
      if (!href) continue;
      const url = href.startsWith('http') ? href : `${BASE_URL}/${href.replace(/^\//, '')}`;
      if (seen.has(url)) continue;
      seen.add(url);

      jobs.push({ title, url, percentage: '', availability: '' });
    }
  }

  return jobs;
}

/**
 * Parse a Moncucco job detail page for full description.
 */
function parseDetailPage(html = '') {
  if (!html) return '';

  const { document } = new JSDOM(html).window;

  const BODY_SELECTORS = [
    '.content',
    '.job-detail',
    '#content',
    'article',
    'main',
    '.container',
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

function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/medic|dottor|chirurg|anest|pronto soccorso|cardiol|radiolog|patolog/i.test(t)) return 'medical';
  if (/infermier|nurse|pflege|cura/i.test(t)) return 'nursing';
  if (/fisioterapi|ergoterapi|logoped|riabilit/i.test(t)) return 'rehabilitation';
  if (/farmaci|pharmacy/i.test(t)) return 'pharmacy';
  if (/laborator|analisi|biomedic/i.test(t)) return 'laboratory';
  if (/admin|segret|contab|buchhalt|account/i.test(t)) return 'admin';
  if (/techni|tecnic|mecanic|elektr|install|manutenz/i.test(t)) return 'engineering';
  if (/cucin|chef|ristora|gastro|cuoco/i.test(t)) return 'hospitality';
  if (/pulizia|housekeep|igiene/i.test(t)) return 'housekeeping';
  if (/\bit\b|software|develop|programm|informatic/i.test(t)) return 'technology';
  return 'healthcare';
}

function detectExperienceLevel(title = '') {
  if (/stage|stagiair|apprendist|junior|tirocinant/i.test(title)) return 'ENTRY';
  if (/senior|capo|responsabil|dirigent|primario|chef/i.test(title)) return 'SENIOR';
  return 'MID';
}

function inferEmploymentType(title = '', percentageText = '') {
  const combined = `${title} ${percentageText}`;
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
 * Fetch all Moncucco jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllMoncuccoJobs() {
  console.log(`  Fetching Moncucco jobs from ${CAREERS_URL}`);

  const html = await fetchHtml(CAREERS_URL, { timeoutMs: 25000 });
  const listings = parseListingPage(html);
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    let description = '';
    if (listing.url) {
      try {
        const detailHtml = await fetchHtml(listing.url, { timeoutMs: 15000 });
        description = parseDetailPage(detailHtml);
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    // Build a snippet from listing metadata if description is thin
    if (!description || description.length < MIN_DESC_LENGTH) {
      const parts = [listing.title, '— Gruppo Ospedaliero Moncucco, Lugano'];
      if (listing.percentage) parts.push(listing.percentage);
      if (listing.availability) parts.push(listing.availability);
      description = parts.join(' ');
    }

    const sourceLang = detectLang(listing.title, 'it');
    const jobSlug = buildJobSlug(`${listing.title} Lugano`, 'moncucco');
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const empType = inferEmploymentType(listing.title, listing.percentage);

    jobs.push({
      id: `${MONCUCCO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MONCUCCO_COMPANY_NAME,
      companyKey: MONCUCCO_KEY,
      companyDomain: MONCUCCO_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Lugano',
      canton: HQ.canton,
      addressLocality: 'Lugano',
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Sanità / Ospedaliero',
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url,
      applyUrl: listing.url,
      source: 'Gruppo Ospedaliero Moncucco Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });
  }

  console.log(`  Total Moncucco jobs discovered: ${jobs.length}`);
  return jobs;
}

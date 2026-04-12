#!/usr/bin/env node
/**
 * Riri Group job parser — Fetcher and job builder.
 *
 * Source: https://www.rfriri.com/en/careers/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRiriJobs()  — Fetch and parse all jobs
 *   - isRiriJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RIRI_KEY = 'riri';
export const RIRI_COMPANY_NAME = 'Riri Group';
export const RIRI_COMPANY_DOMAIN = 'rfriri.com';

const BASE_URL = 'https://www.rfriri.com';
const CAREER_URL = 'https://www.rfriri.com/en/careers/';
const HQ = getCompanyDefaults('riri');

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Riri Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRiriJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RIRI_KEY ||
    key.startsWith('riri') ||
    company.includes('riri group') ||
    url.includes('rfriri.com')
  );
}

/**
 * Validate that a URL belongs to Riri Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'rfriri.com' || host.endsWith('.rfriri.com');
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/* ── HTML Parsing ─────────────────────────────────────────── */

/**
 * Parse the Riri Group careers page.
 * Riri (rfriri.com) is a luxury zipper manufacturer. Their careers page
 * may list open positions as cards, list items, or simple text blocks.
 * The URL is /en/careers/ but the company is Italian-speaking (Mendrisio, TI).
 * Returns an array of { title, url, snippet, location } objects.
 */
function parseListingPage(html = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Look for structured job cards/entries
  const CARD_SELECTORS = [
    '.job-listing', '.job-item', '.job-entry', '.job-card',
    '.vacancy', '.career-item', '.position-item',
    '[class*="job"]', '[class*="career"]', '[class*="position"]',
    '.listing_entry', '.content-item', '.wp-block-post',
  ];

  for (const sel of CARD_SELECTORS) {
    const entries = document.querySelectorAll(sel);
    for (const entry of entries) {
      const titleEl = entry.querySelector('h2 a, h3 a, h4 a, a.title, a[class*="title"]') ||
                       entry.querySelector('h2, h3, h4');
      const title = normalizeSpace(titleEl?.textContent || '');
      if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

      const linkEl = entry.querySelector('a[href]') || titleEl?.closest('a') || titleEl?.querySelector('a');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? (href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`) : '';

      const descEl = entry.querySelector('p, .description, .text, .excerpt, .content');
      const snippet = normalizeSpace(descEl?.textContent || '');

      let location = HQ.city;
      const locationEl = entry.querySelector('.location, [class*="location"], [class*="sede"]');
      if (locationEl) {
        location = normalizeSpace(locationEl.textContent || '') || HQ.city;
      }

      seen.add(title.toLowerCase());
      jobs.push({ title, url, snippet, location });
    }
    if (jobs.length > 0) break;
  }

  // Strategy 2: Look for links with job-related text in main content
  if (jobs.length === 0) {
    const mainContent = document.querySelector('main, #content, .content, article, [role="main"]') || document.body;
    const links = mainContent.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = normalizeSpace(link.textContent || '');
      if (!text || text.length < 5 || seen.has(text.toLowerCase())) continue;

      const combinedCheck = `${text} ${href}`.toLowerCase();
      if (/posizion|lavoro|career|job|vacan|candidat|assunzion|offert/i.test(combinedCheck) &&
          !/(contatt|privacy|cookie|login|register|newsletter|home)/i.test(combinedCheck)) {
        const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
        if (href === '#' || href === '' || url === CAREER_URL) continue;

        seen.add(text.toLowerCase());
        jobs.push({ title: text, url, snippet: '', location: HQ.city });
      }
    }
  }

  // Strategy 3: Look for headings that could be job titles
  if (jobs.length === 0) {
    const headings = document.querySelectorAll('h2, h3, h4');
    for (const heading of headings) {
      const text = normalizeSpace(heading.textContent || '');
      if (!text || text.length < 5 || text.length > 200 || seen.has(text.toLowerCase())) continue;
      if (/^(menu|nav|footer|header|contact|contatt|about|chi siamo)/i.test(text)) continue;

      const linkEl = heading.querySelector('a[href]') || heading.closest('a');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? (href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`) : '';

      const nextEl = heading.nextElementSibling;
      const snippet = nextEl ? normalizeSpace(nextEl.textContent || '').slice(0, 500) : '';

      if (/\b(m\/f|m\/w|posizione|operai|tecnic|ingegner|responsabil|addett|impiegat|manager|assistant|operator|quality|produzion|magazzin|manutenzion)\b/i.test(text) ||
          (snippet && /\b(requisit|mansion|competen|esperien|contratt|sede|candidat)\b/i.test(snippet))) {
        seen.add(text.toLowerCase());
        jobs.push({ title: text, url, snippet, location: HQ.city });
      }
    }
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
    '.job-detail', '.job-description', '.career-detail',
    '.entry-content', '.post-content', '.page-content',
    'article', 'main', '#content', '.content',
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

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Riri Group jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllRiriJobs() {
  console.log(`  Fetching Riri Group jobs from ${CAREER_URL}`);

  let html = '';
  try {
    html = await fetchHtml(CAREER_URL, { timeoutMs: 25000 });
  } catch (err) {
    console.warn(`  Failed to fetch ${CAREER_URL}: ${err.message}`);
    return [];
  }
  const listings = parseListingPage(html);
  console.log(`  Jobs found on listing page: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const listing of listings) {
    let description = listing.snippet || '';
    if (listing.url) {
      try {
        const detailHtml = await fetchHtml(listing.url, { timeoutMs: 25000 });
        const detailBody = parseDetailPage(detailHtml);
        if (detailBody && detailBody.length > description.length) {
          description = detailBody;
        }
      } catch (err) {
        console.warn(`  Detail fetch failed for ${listing.url}: ${err.message}`);
      }
    }

    const location = listing.location || HQ.city;
    const sourceLang = detectLang(listing.title + ' ' + description, 'it');
    const jobSlug = buildJobSlug(`${listing.title} ${location}`, 'riri');
    const urlHash = createHash('sha1').update(listing.url || listing.title).digest('hex').slice(0, 12);

    jobs.push({
      id: `${RIRI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RIRI_COMPANY_NAME,
      companyKey: RIRI_KEY,
      companyDomain: RIRI_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description: description || `${listing.title} — Riri Group`,
      descriptionByLocale: { [sourceLang]: description || `${listing.title} — Riri Group` },
      location,
      canton: HQ.canton,
      addressLocality: location.split('/')[0].trim(),
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Manifatturiero / Moda',
      contract: detectEmploymentType(listing.title + ' ' + description) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.title + ' ' + description),
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url || CAREER_URL,
      applyUrl: listing.url || CAREER_URL,
      source: 'Riri Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`  Total Riri Group jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Alprose job parser — Fetcher and job builder.
 *
 * Source: https://www.alprose.ch/en/jobs/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAlproseJobs()  — Fetch and parse all jobs
 *   - isAlproseJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ALPROSE_KEY = 'alprose';
export const ALPROSE_COMPANY_NAME = 'Alprose';
export const ALPROSE_COMPANY_DOMAIN = 'alprose.ch';

const BASE_URL = 'https://www.alprose.ch';
const CAREER_URL = 'https://www.alprose.ch/en/jobs/';
const HQ = getCompanyDefaults('alprose');

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Alprose.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAlproseJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ALPROSE_KEY ||
    key.startsWith('alprose') ||
    company.includes('alprose') ||
    url.includes('alprose.ch')
  );
}

/**
 * Validate that a URL belongs to Alprose's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'alprose.ch' || host.endsWith('.alprose.ch');
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
 * Parse the Alprose jobs page.
 * Alprose is a chocolate manufacturer based in Caslano, TI. Their /en/jobs/
 * page may have job listings as cards, list items, or simple content blocks.
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
    '.vacancy', '.career-item', '.position-item', '.stelle',
    '[class*="job"]', '[class*="career"]', '[class*="vacanc"]',
    '[class*="stelle"]', '[class*="position"]',
    '.listing_entry', '.content-item', '.wp-block-post',
    '.accordion-item', '.toggle-item', '.collapse-item',
  ];

  for (const sel of CARD_SELECTORS) {
    const entries = document.querySelectorAll(sel);
    for (const entry of entries) {
      const titleEl = entry.querySelector('h2 a, h3 a, h4 a, a.title, a[class*="title"]') ||
                       entry.querySelector('h2, h3, h4, .title');
      const title = normalizeSpace(titleEl?.textContent || '');
      if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

      const linkEl = entry.querySelector('a[href]') || titleEl?.closest('a') || titleEl?.querySelector('a');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? (href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`) : '';

      const descEl = entry.querySelector('p, .description, .text, .content, .excerpt');
      const snippet = normalizeSpace(descEl?.textContent || '');

      let location = HQ.city;
      const locationEl = entry.querySelector('.location, [class*="location"], [class*="standort"], [class*="ort"]');
      if (locationEl) {
        location = normalizeSpace(locationEl.textContent || '') || HQ.city;
      }

      seen.add(title.toLowerCase());
      jobs.push({ title, url, snippet, location });
    }
    if (jobs.length > 0) break;
  }

  // Strategy 2: Look for links with job-related patterns in main content
  if (jobs.length === 0) {
    const mainContent = document.querySelector('main, #content, .content, article, [role="main"]') || document.body;
    const links = mainContent.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = normalizeSpace(link.textContent || '');
      if (!text || text.length < 5 || seen.has(text.toLowerCase())) continue;

      const combinedCheck = `${text} ${href}`.toLowerCase();
      if (/stell|job|vacan|position|karriere|career|beruf|arbeit|mitarbeit|posizion|lavoro|offert/i.test(combinedCheck) &&
          !/(kontakt|impressum|datenschutz|agb|cookie|login|product|schokolade|chocolate|shop)/i.test(combinedCheck)) {
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
      if (/^(menu|nav|footer|header|kontakt|contact|about|product|schokolade|chocolate)/i.test(text)) continue;

      const linkEl = heading.querySelector('a[href]') || heading.closest('a');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? (href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`) : '';

      const nextEl = heading.nextElementSibling;
      const snippet = nextEl ? normalizeSpace(nextEl.textContent || '').slice(0, 500) : '';

      // Look for job-related content (DE/IT/EN patterns for a Swiss-Italian chocolate company)
      if (/\b(m\/w\/d|m\/f|%|stelle|job|position|mitarbeiter|operator|techniker|angestellt|leiter|fachperson|produzion|qualit|magazzin|lagerist|confezion|addett|impiegat|responsabil)\b/i.test(text) ||
          (snippet && /\b(aufgaben|anforderung|bewerbung|anstellung|pensum|requisit|mansion|competen|esperien)\b/i.test(snippet))) {
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
    '.job-detail', '.job-description', '.stelle-detail',
    '.entry-content', '.post-content', '.page-content',
    '.content-detail', '.detail-content',
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
 * Fetch all Alprose jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllAlproseJobs() {
  console.log(`  Fetching Alprose jobs from ${CAREER_URL}`);
  let html = '';
  try {
    html = await fetchHtml(CAREER_URL, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
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
    const sourceLang = detectLang(listing.title + ' ' + description, 'de');
    const jobSlug = buildJobSlug(`${listing.title} ${location}`, 'alprose');
    const urlHash = createHash('sha1').update(listing.url || listing.title).digest('hex').slice(0, 12);

    jobs.push({
      id: `${ALPROSE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ALPROSE_COMPANY_NAME,
      companyKey: ALPROSE_KEY,
      companyDomain: ALPROSE_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description: description || `${listing.title} — Alprose`,
      descriptionByLocale: { [sourceLang]: description || `${listing.title} — Alprose` },
      location,
      canton: HQ.canton,
      addressLocality: location.split('/')[0].trim(),
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Alimentare / Cioccolato',
      contract: detectEmploymentType(listing.title + ' ' + description) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.title + ' ' + description),
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url || CAREER_URL,
      applyUrl: listing.url || CAREER_URL,
      source: 'Alprose Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`  Total Alprose jobs discovered: ${jobs.length}`);
  return jobs;
}

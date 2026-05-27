#!/usr/bin/env node
/**
 * Franklin University Switzerland job parser — Fetcher and job builder.
 *
 * Source: https://www.franklin.edu.ch/about-franklin/job-opportunities
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllFranklinUniversityJobs()  — Fetch and parse all jobs
 *   - isFranklinUniversityJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FRANKLIN_UNIVERSITY_KEY = 'franklin-university';
export const FRANKLIN_UNIVERSITY_COMPANY_NAME = 'Franklin University Switzerland';
export const FRANKLIN_UNIVERSITY_COMPANY_DOMAIN = 'franklin.edu.ch';

const BASE_URL = 'https://www.franklin.edu.ch';
const CAREER_URL = 'https://www.franklin.edu.ch/about-franklin/job-opportunities';
const HQ = getCompanyDefaults('franklin-university');

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Franklin University Switzerland.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isFranklinUniversityJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === FRANKLIN_UNIVERSITY_KEY ||
    key.startsWith('franklin-university') ||
    company.includes('franklin university switzerland') ||
    url.includes('franklin.edu.ch')
  );
}

/**
 * Validate that a URL belongs to Franklin University Switzerland's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'franklin.edu.ch' || host.endsWith('.franklin.edu.ch');
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
 * Parse the Franklin University Switzerland job opportunities page.
 * This is a university website with a simple HTML page listing positions.
 * Common patterns: job titles as headings, sometimes with links to detail
 * pages or PDF descriptions. May also use accordion/collapsible sections.
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
    '[class*="vacancy"]', '[class*="opening"]',
    '.accordion-item', '.toggle-item', '.collapse-item',
    '.listing_entry', '.content-item',
  ];

  for (const sel of CARD_SELECTORS) {
    const entries = document.querySelectorAll(sel);
    for (const entry of entries) {
      const titleEl = entry.querySelector('h2 a, h3 a, h4 a, a.title, a[class*="title"]') ||
                       entry.querySelector('h2, h3, h4, .title, .heading');
      const title = normalizeSpace(titleEl?.textContent || '');
      if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

      const linkEl = entry.querySelector('a[href]') || titleEl?.closest('a') || titleEl?.querySelector('a');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? (href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`) : '';

      const descEl = entry.querySelector('p, .description, .text, .content, .excerpt, .summary');
      const snippet = normalizeSpace(descEl?.textContent || '');

      seen.add(title.toLowerCase());
      jobs.push({ title, url, snippet, location: HQ.city });
    }
    if (jobs.length > 0) break;
  }

  // Strategy 2: Look for headings that are job titles (university style)
  // University job pages often list positions as h2/h3 headings with
  // description paragraphs below them
  if (jobs.length === 0) {
    const mainContent = document.querySelector('main, #content, .content, article, [role="main"], .field--body, .node__content') || document.body;
    const headings = mainContent.querySelectorAll('h2, h3, h4');
    for (const heading of headings) {
      const text = normalizeSpace(heading.textContent || '');
      if (!text || text.length < 5 || text.length > 200 || seen.has(text.toLowerCase())) continue;
      if (/^(menu|navigation|footer|header|contact|about|mission|vision|overview|breadcrumb|main navigation)/i.test(text)) continue;

      const linkEl = heading.querySelector('a[href]') || heading.closest('a');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? (href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`) : '';

      // Gather description from subsequent siblings
      let snippet = '';
      let sibling = heading.nextElementSibling;
      while (sibling && !['H1', 'H2', 'H3', 'H4'].includes(sibling.tagName)) {
        const sibText = normalizeSpace(sibling.textContent || '');
        if (sibText) snippet += (snippet ? ' ' : '') + sibText;
        if (snippet.length > 500) break;
        sibling = sibling.nextElementSibling;
      }
      snippet = snippet.slice(0, 500);

      // Check if it looks like a job/position listing
      if (/\b(professor|lecturer|instructor|faculty|dean|coordinator|advisor|assistant|associate|director|manager|officer|specialist|analyst|librarian|admissions|registrar|researcher|postdoc|adjunct|tenure|visiting)\b/i.test(text) ||
          /\b(position|opening|opportunity|role|vacancy|hire|employ|recruit|applicant|candidate|full[- ]time|part[- ]time)\b/i.test(text) ||
          (snippet && /\b(qualifications|requirements|responsibilities|duties|apply|application|deadline|submit|resume|cv|salary|contract|experience)\b/i.test(snippet))) {
        seen.add(text.toLowerCase());
        jobs.push({ title: text, url, snippet, location: HQ.city });
      }
    }
  }

  // Strategy 3: Look for links with job-related text
  if (jobs.length === 0) {
    const mainContent = document.querySelector('main, #content, .content, article, [role="main"]') || document.body;
    const links = mainContent.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = normalizeSpace(link.textContent || '');
      if (!text || text.length < 5 || seen.has(text.toLowerCase())) continue;

      const combinedCheck = `${text} ${href}`.toLowerCase();
      if (/position|opening|opportunit|job|vacanc|faculty|professor|lecturer|hire|employ|recruit/i.test(combinedCheck) &&
          !/(privacy|cookie|login|student|alumni|admission|program|course|event|news|blog)/i.test(combinedCheck)) {
        const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
        if (href === '#' || href === '' || url === CAREER_URL) continue;

        seen.add(text.toLowerCase());
        jobs.push({ title: text, url, snippet: '', location: HQ.city });
      }
    }
  }

  // Strategy 4: Check for PDF links that might be job descriptions
  if (jobs.length === 0) {
    const pdfLinks = document.querySelectorAll('a[href$=".pdf"]');
    for (const link of pdfLinks) {
      const href = link.getAttribute('href') || '';
      const text = normalizeSpace(link.textContent || '');
      if (!text || text.length < 5 || seen.has(text.toLowerCase())) continue;

      const combinedCheck = `${text} ${href}`.toLowerCase();
      if (/position|job|faculty|opening|vacanc|professor|lecturer/i.test(combinedCheck)) {
        const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;

        // Try to get context from surrounding elements
        const parent = link.parentElement;
        const context = parent ? normalizeSpace(parent.textContent || '').slice(0, 300) : '';

        seen.add(text.toLowerCase());
        jobs.push({ title: text, url: CAREER_URL, snippet: context, location: HQ.city });
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
    '.job-detail', '.job-description', '.position-detail',
    '.field--body', '.node__content', '.page-content',
    '.entry-content', '.post-content',
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
 * Fetch all Franklin University Switzerland jobs. Returns ParsedJob[] (source locale only).
 */
export async function fetchAllFranklinUniversityJobs() {
  console.log(`  Fetching Franklin University Switzerland jobs from ${CAREER_URL}`);
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
    if (listing.url && listing.url !== CAREER_URL) {
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
    const sourceLang = detectLang(listing.title + ' ' + description, 'en');
    const jobSlug = buildJobSlug(`${listing.title} ${location}`, 'franklin-university');
    const urlHash = createHash('sha1').update(listing.url || listing.title).digest('hex').slice(0, 12);

    jobs.push({
      id: `${FRANKLIN_UNIVERSITY_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FRANKLIN_UNIVERSITY_COMPANY_NAME,
      companyKey: FRANKLIN_UNIVERSITY_KEY,
      companyDomain: FRANKLIN_UNIVERSITY_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description: description || `${listing.title} — Franklin University Switzerland`,
      descriptionByLocale: { [sourceLang]: description || `${listing.title} — Franklin University Switzerland` },
      location,
      canton: HQ.canton,
      addressLocality: location.split('/')[0].trim(),
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Istruzione / Universita',
      contract: detectEmploymentType(listing.title + ' ' + description) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.title + ' ' + description),
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url || CAREER_URL,
      applyUrl: listing.url || CAREER_URL,
      source: 'Franklin University Switzerland Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`  Total Franklin University Switzerland jobs discovered: ${jobs.length}`);
  return jobs;
}

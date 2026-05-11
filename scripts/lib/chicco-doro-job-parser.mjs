#!/usr/bin/env node
/**
 * Chicco d'Oro job parser — Fetcher and job builder.
 *
 * Source: https://www.chiccodoro.com/contatti
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllChiccoDoroJobs()  — Fetch and parse all jobs
 *   - isChiccoDoroJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, buildJobSlug, stripHtml, normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CHICCO_DORO_KEY = 'chicco-doro';
export const CHICCO_DORO_COMPANY_NAME = "Chicco d\u2019Oro";
export const CHICCO_DORO_COMPANY_DOMAIN = 'chiccodoro.com';

const BASE_URL = 'https://www.chiccodoro.com';
const CAREER_URL = 'https://www.chiccodoro.com/contatti';
const CAREER_ALT_URLS = [
  'https://www.chiccodoro.com/contatti',
  'https://www.chiccodoro.com/lavora-con-noi',
  'https://www.chiccodoro.com/careers',
];
const HQ = getCompanyDefaults('chicco-doro');

export const MIN_DESC_LENGTH = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Chicco d'Oro.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isChiccoDoroJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CHICCO_DORO_KEY ||
    key.startsWith('chicco-doro') ||
    company.includes("chicco d'oro") || company.includes("chicco d\u2019oro") ||
    url.includes('chiccodoro.com')
  );
}

/**
 * Validate that a URL belongs to Chicco d'Oro's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'chiccodoro.com' || host.endsWith('.chiccodoro.com');
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
 * Parse Chicco d'Oro pages for job listings.
 * The /contatti page is primarily a contact page and may not have structured
 * job listings. We look for:
 *   - Dedicated career sections with job titles
 *   - Links to job detail pages or application forms
 *   - Informal "join us" sections with position descriptions
 *   - mailto: links with job-related subjects
 * Returns an array of { title, url, snippet, location } objects.
 */
function parseListingPage(html = '', pageUrl = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Look for structured job cards or career sections
  const CARD_SELECTORS = [
    '.job-listing', '.job-item', '.job-entry', '.job-card',
    '.vacancy', '.career-item', '.position-item', '.offerta-lavoro',
    '[class*="job"]', '[class*="career"]', '[class*="lavoro"]',
    '[class*="posizion"]', '.listing_entry', '.content-item',
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

      const descEl = entry.querySelector('p, .description, .text, .content');
      const snippet = normalizeSpace(descEl?.textContent || '');

      seen.add(title.toLowerCase());
      jobs.push({ title, url, snippet, location: HQ.city });
    }
    if (jobs.length > 0) break;
  }

  // Strategy 2: Look for headings that could be job titles
  if (jobs.length === 0) {
    const headings = document.querySelectorAll('h2, h3, h4');
    for (const heading of headings) {
      const text = normalizeSpace(heading.textContent || '');
      if (!text || text.length < 5 || text.length > 200 || seen.has(text.toLowerCase())) continue;
      if (/^(menu|nav|footer|header|contatt|contact|chi siamo|dove siamo|about|sede|orari)/i.test(text)) continue;

      const linkEl = heading.querySelector('a[href]') || heading.closest('a');
      const href = linkEl?.getAttribute('href') || '';
      const url = href ? (href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`) : '';

      const nextEl = heading.nextElementSibling;
      const snippet = nextEl ? normalizeSpace(nextEl.textContent || '').slice(0, 500) : '';

      // Check if it resembles a job listing (Italian context)
      if (/\b(posizione|lavora|cercasi|assunzione|candidatura|offerta|impiego|selezione|ricerca personale|collaborator|operai|addett|impiegat|responsabil|tecnic)\b/i.test(text) ||
          /\b(posizione|lavora|cercasi|assunzione|candidatura|offerta|impiego|requisit|mansion|profilo|competen)\b/i.test(snippet)) {
        seen.add(text.toLowerCase());
        jobs.push({ title: text, url, snippet, location: HQ.city });
      }
    }
  }

  // Strategy 3: Look for links to job-related pages within the site
  if (jobs.length === 0) {
    const mainContent = document.querySelector('main, #content, .content, article, [role="main"]') || document.body;
    const links = mainContent.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = normalizeSpace(link.textContent || '');
      if (!text || text.length < 5 || seen.has(text.toLowerCase())) continue;

      const combinedCheck = `${text} ${href}`.toLowerCase();
      if (/posizion|lavora|career|job|vacan|candidat|assunzion|offert|impieg|selezione/i.test(combinedCheck) &&
          !/(contatt|privacy|cookie|login|home|product|prodott|shop|negozio)/i.test(combinedCheck)) {
        const url = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
        if (href === '#' || href === '' || url === pageUrl) continue;

        seen.add(text.toLowerCase());
        jobs.push({ title: text, url, snippet: '', location: HQ.city });
      }
    }
  }

  // Strategy 4: Check for mailto links with job-related subjects
  if (jobs.length === 0) {
    const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
    for (const link of mailtoLinks) {
      const href = link.getAttribute('href') || '';
      const text = normalizeSpace(link.textContent || '');
      const parent = link.parentElement;
      const context = normalizeSpace(parent?.textContent || '');

      if (/lavoro|career|candidatura|posizione|assunzione|impiego/i.test(context) &&
          !seen.has(text.toLowerCase())) {
        // Extract a meaningful title from surrounding context
        const prevHeading = parent?.closest('section, div')?.querySelector('h2, h3, h4');
        const title = prevHeading ? normalizeSpace(prevHeading.textContent || '') : `Candidatura spontanea`;
        if (title.length >= 3) {
          seen.add(title.toLowerCase());
          jobs.push({
            title,
            url: pageUrl,
            snippet: context.slice(0, 500),
            location: HQ.city,
          });
        }
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
 * Fetch all Chicco d'Oro jobs. Returns ParsedJob[] (source locale only).
 *
 * Since the primary URL is /contatti (a contact page), we also try
 * alternative career-related paths to find actual job listings.
 */
export async function fetchAllChiccoDoroJobs() {
  console.log(`  Fetching Chicco d'Oro jobs`);

  let allListings = [];

  for (const url of CAREER_ALT_URLS) {
    try {
      console.log(`  Trying: ${url}`);      let html = '';
  try {
    html = await fetchHtml(url, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
      const listings = parseListingPage(html, url);
      if (listings.length > 0) {
        console.log(`  Jobs found on ${url}: ${listings.length}`);
        allListings = allListings.concat(listings);
      }
    } catch (err) {
      console.warn(`  Failed to fetch ${url}: ${err.message}`);
    }
  }

  // Deduplicate by title
  const seenTitles = new Set();
  allListings = allListings.filter(listing => {
    const key = listing.title.toLowerCase();
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  console.log(`  Total unique listings found: ${allListings.length}`);
  if (!allListings.length) return [];

  const jobs = [];
  for (const listing of allListings) {
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
    const sourceLang = detectLang(listing.title + ' ' + description, 'it');
    const jobSlug = buildJobSlug(`${listing.title} ${location}`, 'chicco-doro');
    const urlHash = createHash('sha1').update(listing.url || listing.title).digest('hex').slice(0, 12);

    jobs.push({
      id: `${CHICCO_DORO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CHICCO_DORO_COMPANY_NAME,
      companyKey: CHICCO_DORO_KEY,
      companyDomain: CHICCO_DORO_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description: description || `${listing.title} \u2014 Chicco d\u2019Oro`,
      descriptionByLocale: { [sourceLang]: description || `${listing.title} \u2014 Chicco d\u2019Oro` },
      location,
      canton: HQ.canton,
      addressLocality: location.split('/')[0].trim(),
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ.postalCode,
      category: detectCategory(listing.title),
      sector: 'Alimentare / Bevande',
      contract: detectEmploymentType(listing.title + ' ' + description) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.title + ' ' + description),
      experienceLevel: detectExperienceLevel(listing.title),
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      url: listing.url || CAREER_URL,
      applyUrl: listing.url || CAREER_URL,
      source: 'Chicco d\u2019Oro Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`  Total Chicco d'Oro jobs discovered: ${jobs.length}`);
  return jobs;
}

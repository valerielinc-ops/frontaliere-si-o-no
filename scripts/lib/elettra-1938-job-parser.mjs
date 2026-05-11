#!/usr/bin/env node
/**
 * Elettra 1938 job parser — Fetcher and job builder.
 *
 * Source: https://www.elettra1938.ch/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllElettra-1938Jobs()  — Fetch and parse all jobs
 *   - isElettra-1938Job()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace as _normalizeSpace, fetchHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ELETTRA_1938_KEY = 'elettra-1938';
export const ELETTRA_1938_COMPANY_NAME = 'Elettra 1938';
export const ELETTRA_1938_COMPANY_DOMAIN = 'elettra1938.ch';

const CAREER_URL = 'https://www.elettra1938.ch/';
const BASE_URL = 'https://www.elettra1938.ch';
const HQ = getCompanyDefaults('elettra-1938');

/**
 * Elettra 1938 is a small local electrical installations company in Mendrisio.
 * They may list jobs on their main website or a /lavora-con-noi page.
 * We try multiple potential paths for job listings.
 */
const JOB_URLS = [
  'https://www.elettra1938.ch/lavora-con-noi',
  'https://www.elettra1938.ch/careers',
  'https://www.elettra1938.ch/posizioni-aperte',
  'https://www.elettra1938.ch/',
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Elettra 1938.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isElettra1938Job(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ELETTRA_1938_KEY ||
    key.startsWith('elettra-1938') ||
    company.includes('elettra 1938') ||
    url.includes('elettra1938.ch')
  );
}

/**
 * Validate that a URL belongs to Elettra 1938's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'elettra1938.ch' || host.endsWith('.elettra1938.ch');
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Parse an Elettra 1938 page HTML for job listings.
 * Small local companies often have a simple "Lavora con noi" section
 * with position titles as headings or list items.
 */
function parsePageForJobs(html = '', pageUrl = '') {
  if (!html) return [];
  const { document } = new JSDOM(html).window;
  const jobs = [];
  const seen = new Set();

  // Strategy 1: Look for JSON-LD JobPosting structured data
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent || '');
      const items = Array.isArray(data) ? data : data?.['@graph'] || [data];
      for (const item of items) {
        if (item?.['@type'] === 'JobPosting') {
          jobs.push({
            title: item.title || '',
            url: item.url || pageUrl,
            location: item.jobLocation?.address?.addressLocality || 'Mendrisio',
            description: item.description || '',
          });
        }
      }
      if (jobs.length > 0) return jobs;
    } catch { /* not valid JSON-LD */ }
  }

  // Strategy 2: Look for dedicated job/career sections
  const JOB_SECTION_SELECTORS = [
    '[class*="lavora"], [class*="career"], [class*="job"], [class*="posizioni"]',
    '[id*="lavora"], [id*="career"], [id*="job"], [id*="posizioni"]',
    'section, article, .content',
  ];

  for (const sectionSel of JOB_SECTION_SELECTORS) {
    const sections = document.querySelectorAll(sectionSel);
    for (const section of sections) {
      const sectionText = (section.textContent || '').toLowerCase();
      // Only process sections that seem job-related
      if (!/lavora|posizion|carriera|career|job|assunzione|offert|cerchiamo|ricerchiamo/i.test(sectionText)) continue;

      // Look for job titles in headings
      const headings = section.querySelectorAll('h2, h3, h4, h5, strong, b');
      for (const heading of headings) {
        const title = normalizeSpace(heading.textContent || '');
        if (!title || title.length < 5 || title.length > 150) continue;
        if (seen.has(title.toLowerCase())) continue;
        // Skip section headings like "Lavora con noi"
        if (/^(lavora con noi|posizioni aperte|careers|offerte di lavoro)$/i.test(title)) continue;

        seen.add(title.toLowerCase());

        // Look for a link in or near the heading
        const link = heading.querySelector('a') || heading.closest('a');
        const href = link?.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : (href ? `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}` : pageUrl);

        // Get description from surrounding text
        const nextSibling = heading.nextElementSibling;
        const desc = nextSibling ? normalizeSpace(nextSibling.textContent || '') : '';

        jobs.push({ title, url, location: 'Mendrisio', description: desc });
      }

      // Also look for list items that might be job postings
      const listItems = section.querySelectorAll('li');
      for (const li of listItems) {
        const text = normalizeSpace(li.textContent || '');
        if (!text || text.length < 10 || text.length > 200) continue;
        if (seen.has(text.toLowerCase())) continue;
        // Must look like a job title (not a navigation item)
        if (/\b(elettricista|tecnico|installat|capo|apprend|montatore|responsab|ingegner|project|operaio)/i.test(text)) {
          seen.add(text.toLowerCase());
          const link = li.querySelector('a');
          const href = link?.getAttribute('href') || '';
          const url = href.startsWith('http') ? href : (href ? `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}` : pageUrl);

          jobs.push({ title: text, url, location: 'Mendrisio', description: '' });
        }
      }
    }
    if (jobs.length > 0) break;
  }

  // Strategy 3: Look for any links that seem job-related
  if (jobs.length === 0) {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const title = normalizeSpace(link.textContent || '');

      if (!title || title.length < 5 || seen.has(title.toLowerCase())) continue;

      // Only follow links that look like job postings or career pages
      const combined = `${href} ${title}`.toLowerCase();
      if (/lavora|posizion|career|job|assunzione|offert|candidat/i.test(combined)) {
        // Skip generic navigation
        if (/^(home|contatti?|chi siamo|servizi|about|contact)$/i.test(title)) continue;

        seen.add(title.toLowerCase());
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
        jobs.push({ title, url: fullUrl, location: 'Mendrisio', description: '', __isNavLink: true });
      }
    }
  }

  return jobs;
}

/**
 * Fetch all Elettra 1938 jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Try multiple potential job page URLs
 *  2. Parse each page for job listings
 *  3. Follow career-related links and parse those pages too
 */
export async function fetchAllElettra1938Jobs() {
  console.log(`🔍 Fetching Elettra 1938 jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let listings = [];

  // Try each potential job page URL
  for (const url of JOB_URLS) {
    try {
      console.log(`   Trying: ${url}`);      let html = '';
  try {
    html = await fetchHtml(url, { timeoutMs: 20000 });
  } catch (err) {
    console.warn(`  Failed to fetch: ${err.message}`);
    return [];
  }
      const found = parsePageForJobs(html, url);

      if (found.length > 0) {
        // If we found navigation links (not actual jobs), follow them
        const navLinks = found.filter((j) => j.__isNavLink);
        const realJobs = found.filter((j) => !j.__isNavLink);

        if (realJobs.length > 0) {
          listings = realJobs;
          console.log(`   Found ${realJobs.length} job listings at ${url}`);
          break;
        }

        // Follow navigation links to find actual job listings
        for (const navLink of navLinks) {
          if (navLink.url === url) continue;
          try {
            console.log(`   Following link: ${navLink.url}`);
            const subHtml = await fetchHtml(navLink.url, { timeoutMs: 15000 });
            const subJobs = parsePageForJobs(subHtml, navLink.url);
            const realSubJobs = subJobs.filter((j) => !j.__isNavLink);
            if (realSubJobs.length > 0) {
              listings = realSubJobs;
              console.log(`   Found ${realSubJobs.length} job listings at ${navLink.url}`);
              break;
            }
          } catch (err) {
            console.log(`   Sub-page fetch failed: ${err.message}`);
          }
        }
        if (listings.length > 0) break;
      }
    } catch (err) {
      console.log(`   Fetch failed for ${url}: ${err.message}`);
    }
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Elettra 1938 job listings found (small company, may not have current openings).');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || '';
    const location = normalizeSpace(rawLocation) || HQ?.city || 'Mendrisio';
    const canton = inferAnyCanton(location) || HQ?.canton || '';
    const descriptionText = stripHtml(listing.description || '');
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'it');
    const jobSlug = slugify(`${title} elettra-1938 ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const desc = descriptionText || `${title} — Posizione presso Elettra 1938 a ${location}. Elettra 1938 è un'azienda specializzata in impianti elettrici, automazione e domotica nel Canton Ticino, con sede a Mendrisio.`;

    const job = {
      id: `elettra-1938-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ELETTRA_1938_COMPANY_NAME,
      companyKey: ELETTRA_1938_KEY,
      companyDomain: ELETTRA_1938_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location,
      canton,
      url: publicUrl,
      source: 'Elettra 1938 Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: location,
      addressRegion: HQ?.addressRegion || 'TI',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ?.postalCode || '6850',
      category: detectCategory(title),
      contract: detectEmploymentType(listing.timeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Impiantistica elettrica / Automazione',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Elettra 1938 jobs discovered: ${jobs.length}`);
  return jobs;
}

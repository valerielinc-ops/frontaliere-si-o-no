#!/usr/bin/env node
/**
 * Gemeinde St. Moritz job parser -- TYPO3 CMS HTML scraper.
 *
 * Source: https://www.gemeinde-stmoritz.ch/aktuelles/offene-stellen
 *
 * TYPO3 listing page shows card teasers with links to detail pages at:
 *   /aktuelles/aktuelles/offene-stellen/detail/{slug}
 *
 * Each detail page has an <h1> title, date, description paragraphs,
 * and optionally a PDF download link for the full Stelleninserat.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGemeindeStMoritzJobs()  -- Fetch and parse all jobs
 *   - isGemeindeStMoritzJob()         -- Match jobs belonging to this company
 *   - isTrustedDomain()               -- Validate URLs belong to this company
 *   - parseListingHtml() / parseDetailHtml() -- Testable pure parsers
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GEMEINDE_ST_MORITZ_KEY = 'gemeinde-st-moritz';
export const GEMEINDE_ST_MORITZ_COMPANY_NAME = 'Gemeinde St. Moritz';
export const GEMEINDE_ST_MORITZ_COMPANY_DOMAIN = 'gemeinde-stmoritz.ch';

const CAREER_URL = 'https://www.gemeinde-stmoritz.ch/aktuelles/offene-stellen';
const BASE_URL = 'https://www.gemeinde-stmoritz.ch';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}


/**
 * Parse a German date like "7. April 2026" or "31. Oktober 2025" to ISO.
 */
export function parseGermanDate(dateStr) {
  if (!dateStr) return '';
  const months = {
    januar: '01', februar: '02', 'märz': '03', maerz: '03', april: '04',
    mai: '05', juni: '06', juli: '07', august: '08', september: '09',
    oktober: '10', november: '11', dezember: '12',
  };
  const m = String(dateStr).trim().match(/(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
  if (!m) return '';
  const [, day, monthName, year] = m;
  const month = months[monthName.toLowerCase()];
  if (!month) return '';
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Gemeinde St. Moritz.
 */
export function isGemeindeStMoritzJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GEMEINDE_ST_MORITZ_KEY ||
    key.startsWith('gemeinde-st-moritz') ||
    company.includes('gemeinde st. moritz') ||
    url.includes('gemeinde-stmoritz.ch')
  );
}

/**
 * Validate that a URL belongs to Gemeinde St. Moritz's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'gemeinde-stmoritz.ch' || host.endsWith('.gemeinde-stmoritz.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|wasserversorgung|infrastruktur)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|verwaltung)/.test(t)) return 'Amministrazione';
  if (/\b(polizist|polizei|sicherheit|feuerwehr)/.test(t)) return 'Sicurezza';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualita';
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
  const pctMatch = t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10);
    if (pct < 80) return 'PART_TIME';
  }
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  if (/100\s*%/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Listing Page Parser ───────────────────────────────────── */

/**
 * Parse the TYPO3 listing page HTML to extract job links.
 *
 * TYPO3 renders job teasers as card-like <a> blocks wrapping the entire
 * card content, each linking to /aktuelles/aktuelles/offene-stellen/detail/{slug}.
 * Inside each card: an image, an h3 title, a date, and teaser text.
 *
 * Returns: Array<{ title, url, date }>
 */
export function parseListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const seen = new Set();
  const jobs = [];

  // Match all <a> tags whose href points to the detail pages
  const linkRegex = /<a[^>]+href=["']([^"']*\/offene-stellen\/detail\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const rawHref = match[1].trim();
    const innerHtml = match[2];

    // Build full URL
    const url = rawHref.startsWith('http') ? rawHref : `${BASE_URL}${rawHref}`;
    if (seen.has(url)) continue;
    seen.add(url);

    // Extract title from <h3> or heading inside the link.
    // TYPO3 cards have multiple h3s: "Mehr lesen" (CTA) and the actual title.
    // Iterate all headings and pick the first non-CTA one.
    let title = '';
    const headingRegex = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi;
    let hMatch;
    while ((hMatch = headingRegex.exec(innerHtml)) !== null) {
      const candidate = normalizeSpace(stripHtml(hMatch[1]));
      if (candidate && candidate.length >= 3 && !/^mehr\s+lesen$/i.test(candidate)) {
        title = candidate;
        break;
      }
    }

    // Fallback: extract slug from URL and humanize it
    if (!title) {
      const slugMatch = rawHref.match(/\/detail\/([^/?#]+)/);
      if (slugMatch) {
        title = normalizeSpace(
          slugMatch[1].replace(/-\d+$/, '').replace(/-/g, ' ')
        );
      }
    }

    if (!title || title.length < 3) continue;

    // Extract date from the card content
    const dateMatch = innerHtml.match(/(\d{1,2}\.\s*\w+\s+\d{4})/);
    const date = dateMatch ? parseGermanDate(dateMatch[1]) : '';

    jobs.push({ title, url, date });
  }

  return jobs;
}

/* ── Detail Page Parser ────────────────────────────────────── */

/**
 * Parse a TYPO3 detail page for a single job posting.
 *
 * The detail page has:
 * - <h1> with the job title
 * - Date as plain text
 * - Description in <p> tags
 * - Optional PDF download link in <a href="/fileadmin/...">
 *
 * Returns: { title, description, date, pdfUrl } or null
 */
export function parseDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  const result = {};

  // Extract title from <h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    result.title = normalizeSpace(stripHtml(h1Match[1]));
  }

  // Extract date from page content (e.g. "7. April 2026")
  const dateMatch = html.match(/(\d{1,2}\.\s*(?:Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4})/i);
  if (dateMatch) {
    result.date = parseGermanDate(dateMatch[1]);
  }

  // Extract PDF link for the Stelleninserat
  const pdfMatch = html.match(/<a[^>]+href=["']([^"']*\/fileadmin\/[^"']*\.pdf)["'][^>]*>/i);
  if (pdfMatch) {
    const pdfHref = pdfMatch[1].trim();
    result.pdfUrl = pdfHref.startsWith('http') ? pdfHref : `${BASE_URL}${pdfHref}`;
  }

  // Extract description: look for main content area
  // TYPO3 typically wraps content in <div class="ce-bodytext"> or similar
  let description = '';

  // Strategy 1: ce-bodytext (common TYPO3 content element)
  const bodyTextMatch = html.match(/<div[^>]*class="[^"]*ce-bodytext[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (bodyTextMatch) {
    description = stripHtml(bodyTextMatch[1]);
  }

  // Strategy 2: all <p> tags within <main> or <article>
  if (!description || description.length < 30) {
    const contentMatch = html.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    if (contentMatch) {
      description = stripHtml(contentMatch[1]);
    }
  }

  // Strategy 3: collect all <p> tags that look like description content
  if (!description || description.length < 30) {
    const paragraphs = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(html)) !== null) {
      const text = normalizeDescriptionSpace(stripHtml(pMatch[1]));
      // Skip navigation, headers, footers, short fragments
      if (text.length > 20 && !/^(Home|Kontakt|Impressum|Datenschutz|Navigation|Menü)/i.test(text)) {
        paragraphs.push(text);
      }
    }
    if (paragraphs.length > 0) {
      description = paragraphs.join('\n\n');
    }
  }

  if (description && description.length >= 30) {
    result.description = description;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/* ── Fetch Helpers ─────────────────────────────────────────── */

async function fetchPage(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Main Fetch ────────────────────────────────────────────── */

/**
 * Fetch all Gemeinde St. Moritz jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllGemeindeStMoritzJobs() {
  console.log('🔍 Fetching Gemeinde St. Moritz jobs');
  console.log(`   Source: ${CAREER_URL}\n`);

  const listingHtml = await fetchPage(CAREER_URL);
  if (!listingHtml) {
    console.warn('  No listing page HTML returned.');
    return [];
  }

  const listings = parseListingHtml(listingHtml);
  if (listings.length === 0) {
    console.warn('  No job listings found on page.');
    return [];
  }

  console.log(`  Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    console.log(`  Fetching detail: ${listing.title}`);

    const detailHtml = await fetchPage(listing.url);
    const detail = detailHtml ? parseDetailHtml(detailHtml) : null;

    const title = detail?.title || listing.title;
    const descriptionText = detail?.description || '';
    const postedDate = detail?.date || listing.date || new Date().toISOString().split('T')[0];
    const publicUrl = listing.url;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} gemeinde-st-moritz ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `gemeinde-st-moritz-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GEMEINDE_ST_MORITZ_COMPANY_NAME,
      companyKey: GEMEINDE_ST_MORITZ_KEY,
      companyDomain: GEMEINDE_ST_MORITZ_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} -- Gemeinde St. Moritz`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} -- Gemeinde St. Moritz` },
      location: 'St. Moritz',
      canton: 'GR',
      url: publicUrl,
      source: 'Gemeinde St. Moritz Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: 'St. Moritz',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '7500',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Amministrazione Pubblica',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`    ${title} -- St. Moritz`);

    // Rate limiting between detail page fetches
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n  Total Gemeinde St. Moritz jobs discovered: ${jobs.length}`);
  return jobs;
}

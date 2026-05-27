#!/usr/bin/env node
/**
 * Montagetechnik BERNER AG job parser — Fetcher and job builder.
 *
 * Source: https://shop.berner.eu/ch-de/vacancies/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBernerMontageJobs()  — Fetch and parse all jobs
 *   - isBernerMontageJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BERNER_MONTAGE_KEY = 'berner-montage';
export const BERNER_MONTAGE_COMPANY_NAME = 'Montagetechnik BERNER AG';
export const BERNER_MONTAGE_COMPANY_DOMAIN = 'berner.eu';

const CAREER_URL = 'https://shop.berner.eu/ch-de/vacancies/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}


/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Montagetechnik BERNER AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBernerMontageJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BERNER_MONTAGE_KEY ||
    key.startsWith('berner-montage') ||
    company.includes('montagetechnik berner ag') ||
    url.includes('berner.eu')
  );
}

/**
 * Validate that a URL belongs to Montagetechnik BERNER AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'berner.eu' || host.endsWith('.berner.eu');
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

/* ── HTML Scraping ────────────────────────────────────────── */

/**
 * Montagetechnik BERNER AG (part of Berner Group) posts jobs at
 * shop.berner.eu/ch-de/vacancies/. The page renders job listings
 * as HTML with links to individual job detail pages.
 *
 * The site requires browser-like headers to avoid 403 responses.
 * Job listings contain title, location, and link to detail page.
 * Detail pages may contain richer descriptions.
 */

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'User-Agent': USER_AGENT,
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Fetch the career page HTML with browser-like headers.
 */
async function fetchCareerPage() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CAREER_URL, {
      signal: controller.signal,
      headers: BROWSER_HEADERS,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from career page`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch a job detail page for richer description.
 */
async function fetchDetailPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: BROWSER_HEADERS,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();

    // Try to extract JSON-LD for structured job data
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(ldMatch[1]);
        if (data['@type'] === 'JobPosting') {
          return {
            description: stripHtml(data.description || ''),
            location: normalizeSpace(data.jobLocation?.address?.addressLocality || ''),
            datePosted: data.datePosted || '',
            employmentType: data.employmentType || '',
          };
        }
      } catch { /* ignore */ }
    }

    // Fallback: extract all text-media-combo blocks (detail pages use these
    // for "Was dich erwartet", "Was dich auszeichnet", "Was wir bieten", etc.)
    const comboRegex = /<div[^>]*class="text-media-combo-container[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="text-media-combo-container|<\/main|$)/gi;
    const comboParts = [];
    let cm;
    while ((cm = comboRegex.exec(html)) !== null) {
      const text = stripHtml(cm[1]).trim();
      if (text.length > 20) comboParts.push(text);
    }
    if (comboParts.length > 0) {
      return { description: comboParts.join('\n\n').substring(0, 4000), location: '', datePosted: '', employmentType: '' };
    }

    // Last resort: main/article
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (mainMatch) {
      return { description: stripHtml(mainMatch[1]).substring(0, 2000), location: '', datePosted: '', employmentType: '' };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse job listings from the career page HTML.
 *
 * The shop.berner.eu career page uses "text-media-combo-container" divs
 * for each job listing, with:
 *   - <h1> containing the job title
 *   - <div class="text-media-combo-description"> with contact info text
 *   - <a href="..."> with "Zum Stelleninserat" / "Vers l'offre d'emploi"
 *     pointing to the detail page
 *
 * Returns array of { title, url, description }.
 */
function parseJobsFromHtml(html = '') {
  const listings = [];
  const seen = new Set();

  // Strategy 1: Find JSON-LD JobPosting entries (if present)
  const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(ldMatch[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'JobPosting' && item.title) {
          const url = item.url || item.sameAs || '';
          const key = `${item.title}|${url}`;
          if (!seen.has(key)) {
            seen.add(key);
            listings.push({
              title: normalizeSpace(item.title),
              url: normalizeSpace(url),
              location: normalizeSpace(item.jobLocation?.address?.addressLocality || ''),
              description: stripHtml(item.description || ''),
              datePosted: item.datePosted || '',
              employmentType: item.employmentType || '',
            });
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Strategy 2: Parse text-media-combo-container blocks
  // Each block is a job listing with h1 title and detail link
  const comboRegex = /<div[^>]*class="text-media-combo-container[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="text-media-combo-container|$)/gi;
  let comboMatch;
  while ((comboMatch = comboRegex.exec(html)) !== null) {
    const block = comboMatch[1];

    // Extract title from <h1>
    const h1Match = block.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!h1Match) continue;
    const title = normalizeSpace(stripHtml(h1Match[1]));
    if (!title || title.length < 5) continue;
    // Skip the main page heading "Aktuelle Stellenangebote"
    if (/^aktuelle\s+stellenangebote$/i.test(title)) continue;

    // Extract detail URL from the "Zum Stelleninserat" / "Vers l'offre d'emploi" link
    const linkMatch = block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?(?:Stelleninserat|offre d'emploi)/i);
    const detailUrl = linkMatch ? linkMatch[1].trim() : '';
    const fullUrl = detailUrl.startsWith('http')
      ? detailUrl
      : (detailUrl ? `https://shop.berner.eu${detailUrl}` : CAREER_URL);

    // Extract description text from the combo description div
    const descMatch = block.match(/<div[^>]*class="text-media-combo-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const descText = descMatch ? normalizeDescriptionSpace(stripHtml(descMatch[1])) : '';

    const key = `${title}|${fullUrl}`;
    if (!seen.has(key)) {
      seen.add(key);
      listings.push({
        title,
        url: fullUrl,
        location: '', // Will be inferred from detail page or defaults
        description: descText,
        datePosted: '',
        employmentType: '',
      });
    }
  }

  return listings;
}

/**
 * Fetch all Montagetechnik BERNER AG jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch career page HTML (with browser-like headers)
 *   2. Parse job listings from HTML/JSON-LD
 *   3. Optionally fetch detail pages for richer descriptions
 *   4. Build ParsedJob objects
 *
 * Note: The shop.berner.eu site may block automated requests with 403.
 * If so, the crawler will return an empty array gracefully and retry next cycle.
 */
export async function fetchAllBernerMontageJobs() {
  console.log(`🔍 Fetching Montagetechnik BERNER AG jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  let html;
  try {
    html = await fetchCareerPage();
  } catch (err) {
    console.warn(`⚠️ Career page fetch failed: ${err?.message}`);
    console.warn('   The site may be blocking automated requests. Will retry next cycle.');
    return [];
  }

  const listings = parseJobsFromHtml(html);
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings found on career page.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = listing.title;
    if (!title || title.length < 3) continue;

    // Fetch detail page if we have a URL and no/thin description
    const listingWordCount = (listing.description || '').split(/\s+/).filter(Boolean).length;
    let detail = null;
    if (listing.url && listing.url !== CAREER_URL && listingWordCount < 50) {
      try {
        detail = await fetchDetailPage(listing.url);
        console.log(`  ✅ ${title.substring(0, 60)}${detail?.description ? '' : ' (no detail content)'}`);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed for ${title}: ${err?.message}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    const city = listing.location || detail?.location || 'Visp';
    const canton = inferAnyCanton(city) || 'VS';
    // Prefer detail page description when it's richer than the listing excerpt
    const detailWords = (detail?.description || '').split(/\s+/).filter(Boolean).length;
    const listingWords = (listing.description || '').split(/\s+/).filter(Boolean).length;
    const description = (detailWords > listingWords ? detail.description : listing.description)
      || `${title} — Montagetechnik BERNER AG, ${city}`;
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} berner-montage ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const datePosted = listing.datePosted || detail?.datePosted || '';

    const job = {
      // ── Required fields ──
      id: `berner-montage-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BERNER_MONTAGE_COMPANY_NAME,
      companyKey: BERNER_MONTAGE_KEY,
      companyDomain: BERNER_MONTAGE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Montagetechnik BERNER AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode: '3930',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.employmentType || detail?.employmentType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Bau / Montage',
      currency: 'CHF',
      featured: false,
      postedDate: datePosted ? datePosted.split('T')[0] : new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Montagetechnik BERNER AG jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * OMEGA SA job parser — Custom Magento career portal (Lumesse TalentLink ATS).
 *
 * OMEGA SA is a Swatch Group subsidiary (luxury watches).
 * Career portal: https://www.omegawatches.com/careers/list
 *
 * The career site is a custom Magento-based portal with server-rendered HTML.
 * No public JSON API — we scrape the list page and detail pages.
 *
 * List page: https://www.omegawatches.com/careers/list?country_id=40
 *   - country_id=40 = Switzerland
 *   - Returns server-rendered HTML with job listings
 *   - Each listing links to: /careers/view/{jobId}/{lang}
 *
 * Detail page structure (CSS classes):
 *   - .ow-jobs-details__heading-country — full address + region
 *   - .ow-jobs-details__heading-title   — job title (h1)
 *   - .ow-jobs-details__tags-item       — tags (working time, domain, level, contract, language)
 *   - section.company-description       — company intro
 *   - section.description               — job description (tasks)
 *   - section.profile                   — candidate profile
 *   - section.requirements              — requirements
 *   - section.language-requirements     — language requirements
 *   - a.apply href                      — Lumesse TalentLink apply URL
 *
 * Only Valais-located jobs are included (filtered by region in address).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllOmegaJobs()     — Fetch and parse all Valais jobs
 *   - isOmegaJob()            — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const OMEGA_KEY = 'omega';
export const OMEGA_COMPANY_NAME = 'OMEGA SA';
export const OMEGA_COMPANY_DOMAIN = 'omegawatches.com';

const BASE_URL = 'https://www.omegawatches.com';
const LIST_URL = `${BASE_URL}/careers/list?country_id=40`;

/**
 * Valais region identifiers in Omega's address strings.
 * Format: "Street, ZIP City, Country - Country (Region)"
 */
const VALAIS_PATTERNS = [
  'valais', 'wallis', 'vallese',
  'zermatt', 'sierre', 'sion', 'visp', 'brig', 'martigny', 'monthey',
  'crans-montana', 'verbier', 'naters', 'saas-fee',
];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert HTML fragments to plain-text description.
 */
function htmlToText(html = '') {
  if (!html || !html.trim()) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x20;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

/**
 * Check if a location string refers to Valais/Wallis.
 */
function isValaisLocation(locationStr = '') {
  const lower = normalize(locationStr);
  return VALAIS_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Parse address from Omega's location format:
 * "Bahnhofstrasse 30a, 3920 Zermatt, Schweiz - Schweiz (Valais)"
 */
function parseAddress(locationStr = '') {
  const parts = locationStr.split(' - ');
  const addressPart = (parts[0] || '').trim();
  const regionPart = (parts[1] || '').trim();

  // Extract region from parentheses: "Schweiz (Valais)" -> "Valais"
  const regionMatch = regionPart.match(/\(([^)]+)\)/);
  const region = regionMatch ? regionMatch[1].trim() : '';

  // Parse address components: "Bahnhofstrasse 30a, 3920 Zermatt, Schweiz"
  const addressParts = addressPart.split(',').map((s) => s.trim());
  const street = addressParts[0] || '';

  // Find postal code + city: "3920 Zermatt"
  let postalCode = '';
  let city = '';
  for (const part of addressParts) {
    const zipCityMatch = part.trim().match(/^(\d{4})\s+(.+)$/);
    if (zipCityMatch) {
      postalCode = zipCityMatch[1];
      city = zipCityMatch[2];
      break;
    }
  }

  return { street, postalCode, city, region };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to OMEGA SA.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isOmegaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === OMEGA_KEY ||
    key.startsWith('omega') ||
    company.includes('omega sa') ||
    url.includes('omegawatches.com')
  );
}

/**
 * Validate that a URL belongs to OMEGA SA's trusted domains.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'omegawatches.com' ||
      host.endsWith('.omegawatches.com') ||
      host.includes('lumessetalentlink.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', domain = '') {
  const t = normalize(`${title} ${domain}`);
  if (/\b(verkauf|vente|vendita|sales|retail|boutique|representative)/.test(t)) return 'Commerciale';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|horlog|watchmak|uhrmach)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|warehouse|supply)/.test(t)) return 'Logistica';
  if (/\b(customer.?service|service.?client|kundendienst|care.?advisor)/.test(t)) return 'Servizio Clienti';
  if (/\b(it\b|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(director|direktor|dirett|manager|leiter|responsab)/.test(t)) return 'Management';
  if (/\b(r&d|research|forschung|ricerca)/.test(t)) return 'Ricerca e Sviluppo';
  return 'Altro';
}

function detectExperienceLevel(title = '', position = '') {
  const t = normalize(`${title} ${position}`);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|deputy|manager|management|cadre)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(workingTime = '', title = '') {
  const t = normalize(`${workingTime} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel|\d+\s*%)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|plein temps)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

function detectContractType(contractStr = '') {
  const t = normalize(contractStr);
  if (/\b(unbefristet|indetermin|permanent|cdi)/.test(t)) return 'permanent';
  if (/\b(befristet|determin|temporary|cdd)/.test(t)) return 'fixed-term';
  return 'full-time';
}

/* ── HTTP Client ───────────────────────────────────────────── */

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Fetch a page with timeout, browser-like headers, and retry on 403.
 *
 * The omegawatches.com site uses WAF-based bot protection. The crawler
 * may receive 403 responses locally but succeed in CI (different IP).
 * We retry once with a delay to handle transient blocks.
 */
async function fetchPage(url, retries = 1) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,de;q=0.8,fr;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          Referer: 'https://www.omegawatches.com/careers',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'User-Agent': USER_AGENT,
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (res.status === 403 && attempt < retries) {
        console.warn(`  ⚠️ HTTP 403 from ${url} — retrying in 3s (attempt ${attempt + 1}/${retries + 1})...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries && !err.message?.includes('abort')) {
        console.warn(`  ⚠️ Fetch error: ${err.message} — retrying...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts`);
}

/* ── List Page Parser ─────────────────────────────────────── */

/**
 * Parse the list page HTML to extract job listing URLs and basic info.
 * Returns an array of { url, title, locationStr, tags[] }.
 */
function parseListPage(html = '') {
  const listings = [];

  // Match each listing item block
  const itemPattern = /class="ow-jobs-listing__item\s+followlink\s+item-\d+"[\s\S]*?(?=class="ow-jobs-listing__item\s+followlink|<\/section|<\/ul>)/g;
  const items = html.match(itemPattern) || [];

  for (const item of items) {
    // Extract detail URL: /careers/view/{id}/{lang}
    const urlMatch = item.match(/href="([^"]*\/careers\/view\/\d+\/\w+)"/);
    if (!urlMatch) continue;

    const detailUrl = urlMatch[1].startsWith('http')
      ? urlMatch[1]
      : `${BASE_URL}${urlMatch[1]}`;

    // Extract title
    const titleMatch = item.match(/class="ow-jobs-listing__title[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';

    // Extract location
    const locMatch = item.match(/class="ow-jobs-listing__heading-country[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/);
    const locationStr = locMatch ? normalizeSpace(htmlToText(locMatch[1])) : '';

    // Extract tags (working time, domain, level, contract, language)
    const tags = [];
    const tagPattern = /<span class="label">([\s\S]*?)<\/span>/g;
    let tagMatch;
    while ((tagMatch = tagPattern.exec(item)) !== null) {
      tags.push(normalizeSpace(tagMatch[1]));
    }

    listings.push({ url: detailUrl, title, locationStr, tags });
  }

  return listings;
}

/* ── Detail Page Parser ───────────────────────────────────── */

/**
 * Parse a detail page to extract full job information.
 */
function parseDetailPage(html = '') {
  const sections = {};

  // Extract each named section
  const sectionPattern = /class="ow-jobs-details__section\s+([\w-]+)"[\s\S]*?<h2>([\s\S]*?)<\/h2>([\s\S]*?)(?=<\/section>)/g;
  let secMatch;
  while ((secMatch = sectionPattern.exec(html)) !== null) {
    const sectionName = secMatch[1].trim();
    const content = htmlToText(secMatch[3]);
    if (content) {
      sections[sectionName] = content;
    }
  }

  // Extract apply URL
  const applyMatch = html.match(/href="([^"]*lumessetalentlink\.com[^"]*)"/);
  const applyUrl = applyMatch
    ? applyMatch[1].replace(/&amp;/g, '&')
    : '';

  // Extract title from h1
  const h1Match = html.match(/class="ow-jobs-details__heading-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  const detailTitle = h1Match ? normalizeSpace(htmlToText(h1Match[1])) : '';

  // Extract full location from detail page
  const locMatch = html.match(/class="ow-jobs-details__heading-country[^"]*"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/);
  const detailLocation = locMatch ? normalizeSpace(htmlToText(locMatch[1])) : '';

  // Extract tags
  const tags = [];
  const tagPattern = /class="ow-jobs-details__tags-item"[\s\S]*?<span>([\s\S]*?)<\/span>/g;
  let tagMatch;
  while ((tagMatch = tagPattern.exec(html)) !== null) {
    tags.push(normalizeSpace(tagMatch[1]));
  }

  return { sections, applyUrl, detailTitle, detailLocation, tags };
}

/**
 * Build a structured description from detail page sections.
 */
function buildDescription(sections = {}, title = '', city = '') {
  const parts = [];

  if (sections['company-description']) {
    parts.push(sections['company-description']);
  }

  if (sections['description']) {
    parts.push('## Stellenbeschreibung\n' + sections['description']);
  }

  if (sections['profile']) {
    parts.push('## Profil\n' + sections['profile']);
  }

  if (sections['requirements']) {
    parts.push('## Anforderungen\n' + sections['requirements']);
  }

  if (sections['language-requirements']) {
    parts.push('## Sprachen\n' + sections['language-requirements']);
  }

  if (parts.length === 0) {
    return `${title} - OMEGA SA, ${city || 'Valais'}, Switzerland`;
  }

  return parts.join('\n\n');
}

/**
 * Extract requirements from detail page sections.
 */
function extractRequirements(sections = {}) {
  const reqs = [];

  for (const key of ['requirements', 'profile', 'language-requirements']) {
    const text = sections[key] || '';
    if (!text) continue;

    const lines = text.split('\n')
      .map((line) => line.replace(/^-\s*/, '').trim())
      .filter((line) => line.length > 3);
    reqs.push(...lines);
  }

  return reqs;
}

/* ── Main Fetcher ─────────────────────────────────────────── */

/**
 * Fetch all OMEGA SA jobs in Valais.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllOmegaJobs() {
  console.log(`🔍 Fetching OMEGA SA jobs`);
  console.log(`   Platform: Custom Magento career portal (Lumesse TalentLink ATS)`);
  console.log(`   List URL: ${LIST_URL}`);
  console.log(`   Filter: Switzerland (country_id=40), then Valais by address\n`);

  // Step 1: Fetch the list page
  console.log(`  📄 Fetching Switzerland job listings...`);
  let listHtml;
  try {
    listHtml = await fetchPage(LIST_URL);
  } catch (err) {
    console.error(`  ❌ Failed to fetch list page: ${err.message}`);
    if (err.message?.includes('403')) {
      console.warn('   The site may be blocking automated requests. Will retry next cycle.');
    }
    return [];
  }

  const listings = parseListPage(listHtml);
  console.log(`  📦 Found ${listings.length} Switzerland jobs total`);

  // Step 2: Filter to Valais-only jobs
  const valaisListings = listings.filter((l) => isValaisLocation(l.locationStr));
  console.log(`  🏔️ Valais jobs: ${valaisListings.length}`);

  if (valaisListings.length === 0) {
    console.warn('⚠️ No Valais job listings found.');
    return [];
  }

  // Step 3: Fetch each detail page for full information
  const jobs = [];
  for (const listing of valaisListings) {
    console.log(`  📄 Fetching detail: ${listing.title}`);

    let detailData = { sections: {}, applyUrl: '', detailTitle: '', detailLocation: '', tags: [] };
    try {
      const detailHtml = await fetchPage(listing.url);
      detailData = parseDetailPage(detailHtml);
      await new Promise((r) => setTimeout(r, 500)); // Rate limiting
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail page for "${listing.title}": ${err.message}`);
    }

    // Use detail page data when available, fall back to list data
    const title = normalizeSpace(detailData.detailTitle || listing.title);
    if (!title || title.length < 3) continue;

    const locationStr = detailData.detailLocation || listing.locationStr;
    const address = parseAddress(locationStr);
    const city = address.city || 'Zermatt';
    const canton = normalizeCantonCode(address.region) || inferAnyCanton(city) || 'VS';

    // Tags from detail or list
    const tags = detailData.tags.length > 0 ? detailData.tags : listing.tags;
    const workingTime = tags[0] || '';
    const domain = tags[1] || '';
    const positionLevel = tags[2] || '';
    const contractStr = tags[3] || '';
    const language = tags[4] || '';

    // Description
    const descriptionText = buildDescription(detailData.sections, title, city);
    const requirements = extractRequirements(detailData.sections);

    // Determine source language from detail page lang code or content
    const urlLangMatch = listing.url.match(/\/(\w{2})$/);
    const urlLang = urlLangMatch ? urlLangMatch[1] : '';
    const sourceLang = detectLang(descriptionText || title, urlLang || 'en');

    // Extract job ID from URL: /careers/view/{jobId}/{lang}
    const jobIdMatch = listing.url.match(/\/careers\/view\/(\d+)\//);
    const jobId = jobIdMatch ? jobIdMatch[1] : '';
    const stableId = jobId
      ? `omega-${jobId}`
      : `omega-${createHash('sha1').update(listing.url).digest('hex').slice(0, 12)}`;

    const jobSlug = slugify(`${title} omega ${city}`);

    const applyUrl = detailData.applyUrl || listing.url;

    const job = {
      // ── Required fields ──
      id: stableId,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: OMEGA_COMPANY_NAME,
      companyKey: OMEGA_KEY,
      companyDomain: OMEGA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: listing.url,
      source: 'OMEGA SA Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Location details ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      ...(address.postalCode ? { postalCode: address.postalCode } : {}),
      ...(address.street ? { streetAddress: address.street } : {}),

      // ── Job metadata ──
      category: detectCategory(title, domain),
      contract: detectContractType(contractStr),
      employmentType: detectEmploymentType(workingTime, title),
      experienceLevel: detectExperienceLevel(title, positionLevel),
      sector: 'Orologeria di lusso',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl,

      // ── Requirements ──
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city} (${canton})`);
  }

  console.log(`\n📋 Total OMEGA SA Valais jobs discovered: ${jobs.length}`);
  return jobs;
}

/**
 * Normalize canton code from region names.
 */
function normalizeCantonCode(regionName = '') {
  const lower = normalize(regionName);
  if (['wallis', 'valais', 'vallese'].some((n) => lower.includes(n))) return 'VS';
  if (['tessin', 'ticino'].some((n) => lower.includes(n))) return 'TI';
  if (['graubünden', 'graubunden', 'grigioni', 'grisons'].some((n) => lower.includes(n))) return 'GR';
  if (['bern', 'berne', 'berna'].some((n) => lower.includes(n))) return 'BE';
  if (['zürich', 'zurich', 'zurigo'].some((n) => lower.includes(n))) return 'ZH';
  return inferAnyCanton(regionName) || '';
}

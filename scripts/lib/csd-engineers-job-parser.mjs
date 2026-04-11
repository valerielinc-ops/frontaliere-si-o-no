#!/usr/bin/env node
/**
 * CSD ENGINEERS job parser — Fetcher and job builder.
 *
 * Source: https://jobs.csd.ch/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCsdEngineersJobs()  — Fetch and parse all jobs
 *   - isCsdEngineersJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CSD_ENGINEERS_KEY = 'csd-engineers';
export const CSD_ENGINEERS_COMPANY_NAME = 'CSD ENGINEERS';
export const CSD_ENGINEERS_COMPANY_DOMAIN = 'csd.ch';

const CAREER_URL = 'https://jobs.csd.ch/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to CSD ENGINEERS.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCsdEngineersJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CSD_ENGINEERS_KEY ||
    key.startsWith('csd-engineers') ||
    company.includes('csd engineers') ||
    url.includes('csd.ch')
  );
}

/**
 * Validate that a URL belongs to CSD ENGINEERS's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'csd.ch' || host.endsWith('.csd.ch');
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

/* ── Valais location filter ────────────────────────────────── */

/**
 * Valais-relevant locations: Sion HQ + satellite offices in canton VS.
 * CSD also has offices in Lausanne, Zurich, Bern, Chur, Luxembourg, etc.
 * We only keep jobs physically based in Valais.
 */
const VALAIS_PATTERNS = [
  'sion', 'sierre', 'martigny', 'monthey', 'visp', 'brig',
  'naters', 'saxon', 'valais', 'wallis',
];

function isValaisLocation(text = '') {
  const t = String(text || '').toLowerCase();
  return VALAIS_PATTERNS.some((p) => t.includes(p));
}

/* ── RSS + Detail Page Fetch ──────────────────────────────── */

const RSS_URL = 'https://jobs.csd.ch/jobs.rss';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/**
 * Fetch the Teamtailor RSS feed and parse all job items.
 * Returns array of { title, link, pubDate, department, location, remoteStatus }.
 */
async function fetchRssFeed() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(RSS_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml',
        'User-Agent': USER_AGENT,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from RSS feed`);
    const xml = await res.text();

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = extractTag(block, 'title');
      const link = extractTag(block, 'link');
      const pubDate = extractTag(block, 'pubDate');

      // Teamtailor uses tt: namespace prefix for custom fields
      const department = extractTag(block, 'tt:department');
      const remoteStatus = extractTag(block, 'remoteStatus');

      // Extract location from tt:locations block
      const locBlock = block.match(/<tt:locations>([\s\S]*?)<\/tt:locations>/s);
      let city = '';
      let country = '';
      let locationName = '';
      let zip = '';
      let street = '';
      if (locBlock) {
        city = extractTag(locBlock[1], 'tt:city');
        country = extractTag(locBlock[1], 'tt:country');
        locationName = extractTag(locBlock[1], 'tt:name');
        zip = extractTag(locBlock[1], 'tt:zip');
        street = extractTag(locBlock[1], 'tt:address');
      }

      items.push({
        title: normalizeSpace(title),
        link: normalizeSpace(link),
        pubDate: normalizeSpace(pubDate),
        department: normalizeSpace(department),
        city: normalizeSpace(city),
        country: normalizeSpace(country),
        locationName: normalizeSpace(locationName),
        postalCode: normalizeSpace(zip),
        street: normalizeSpace(street),
        remoteStatus: normalizeSpace(remoteStatus),
      });
    }
    return items;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Extract text content from an XML tag, handling CDATA.
 */
function extractTag(block, tag) {
  const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 's');
  const plainRe = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 's');
  const m = block.match(cdataRe) || block.match(plainRe);
  return m ? m[1].trim() : '';
}

/**
 * Fetch a detail page and extract structured data from JSON-LD.
 * Returns { city, postalCode, street, description, employmentType, datePosted } or null.
 */
async function fetchDetailPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': USER_AGENT,
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();

    const result = {
      city: '', postalCode: '', street: '',
      description: '', employmentType: '', datePosted: '',
    };

    // Extract JSON-LD JobPosting data
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(ldMatch[1]);
        if (data['@type'] !== 'JobPosting') continue;

        // Location
        const loc = data.jobLocation;
        const addr = Array.isArray(loc) ? (loc[0]?.address || {}) : (loc?.address || {});
        result.city = normalizeSpace(addr.addressLocality || '');
        result.postalCode = normalizeSpace(addr.postalCode || '');
        result.street = normalizeSpace(addr.streetAddress || '');

        // Description
        if (data.description) {
          const desc = stripHtml(data.description);
          if (desc.length >= 50) result.description = desc;
        }

        // Employment type and date
        result.employmentType = normalizeSpace(data.employmentType || '');
        result.datePosted = normalizeSpace(data.datePosted || '');
      } catch { /* ignore malformed JSON-LD */ }
    }

    return result;
  } catch {
    return null;
  }
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all CSD ENGINEERS jobs in Valais from the Teamtailor RSS feed.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch RSS feed (all jobs globally)
 *   2. Filter for Valais-based jobs (location in RSS or detail page)
 *   3. Fetch detail page for each Valais job (JSON-LD for description)
 *   4. Build ParsedJob objects
 */
export async function fetchAllCsdEngineersJobs() {
  console.log(`🔍 Fetching CSD ENGINEERS jobs`);
  console.log(`   RSS: ${RSS_URL}\n`);

  const rssItems = await fetchRssFeed();
  if (!rssItems || rssItems.length === 0) {
    console.warn('⚠️ No RSS items returned.');
    return [];
  }

  console.log(`  📋 Total RSS items: ${rssItems.length}`);

  // Pre-filter by location from RSS metadata (tt:city, tt:name, tt:department)
  const valaisItems = rssItems.filter((item) => {
    const locationText = `${item.city} ${item.locationName} ${item.department} ${item.country}`;
    return isValaisLocation(locationText);
  });

  console.log(`  🏔️  Valais-relevant items: ${valaisItems.length}`);

  if (valaisItems.length === 0) {
    console.warn('⚠️ No Valais jobs found in RSS feed.');
    return [];
  }

  const jobs = [];
  for (const item of valaisItems) {
    const title = item.title;
    if (!title || title.length < 3) continue;

    // Fetch detail page for richer data
    let detail = null;
    if (item.link) {
      try {
        detail = await fetchDetailPage(item.link);
        console.log(`  ✅ ${title.substring(0, 60)}`);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed for ${title}: ${err?.message}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // Use RSS city/location data, fall back to detail page or defaults
    const city = item.city || detail?.city || 'Sion';
    const canton = inferSwissTargetCanton(city) || 'VS';
    const descriptionText = detail?.description || `${title} — CSD ENGINEERS, ${city}`;
    const publicUrl = item.link || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} csd-engineers ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    // Parse date from RSS pubDate or JSON-LD datePosted
    let postedDate = '';
    if (detail?.datePosted) {
      postedDate = detail.datePosted.split('T')[0];
    } else if (item.pubDate) {
      try {
        postedDate = new Date(item.pubDate).toISOString().split('T')[0];
      } catch { /* fallback below */ }
    }

    const job = {
      // ── Required fields ──
      id: `csd-engineers-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CSD_ENGINEERS_COMPANY_NAME,
      companyKey: CSD_ENGINEERS_KEY,
      companyDomain: CSD_ENGINEERS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: publicUrl,
      source: 'CSD ENGINEERS Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      postalCode: item.postalCode || detail?.postalCode || '1950',
      streetAddress: item.street || detail?.street || 'Rue de l\'Industrie 54',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ingegneria / Ambiente',
      currency: 'CHF',
      featured: false,
      postedDate: postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total CSD ENGINEERS Valais jobs discovered: ${jobs.length}`);
  return jobs;
}

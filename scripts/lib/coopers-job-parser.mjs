#!/usr/bin/env node
/**
 * Coopers Group AG job parser — Fetcher and job builder.
 *
 * Source: https://www.coopers.ch/en/about/join-us.php
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCoopersJobs()  — Fetch and parse all jobs
 *   - isCoopersJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const COOPERS_KEY = 'coopers';
export const COOPERS_COMPANY_NAME = 'Coopers Group AG';
export const COOPERS_COMPANY_DOMAIN = 'coopers.ch';

const CAREER_URL = 'https://www.coopers.ch/en/about/join-us.php';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Coopers Group AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCoopersJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === COOPERS_KEY ||
    key.startsWith('coopers') ||
    company.includes('coopers group ag') ||
    url.includes('coopers.ch')
  );
}

/**
 * Validate that a URL belongs to Coopers Group AG's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'coopers.ch' || host.endsWith('.coopers.ch');
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
 * Coopers Group AG is a pharma/life sciences staffing & services company
 * based in Visp (VS). Their career page is a PHP-based site at:
 *   https://www.coopers.ch/en/jobs/index.php
 *
 * The listing page is server-rendered HTML. Each job entry contains:
 *   - Title (in <h4><a>) with link to detail page
 *   - Location, contract type, hours, reference code, posted date
 *   - Detail URL pattern: /en/jobs/detail.php?refCode={CODE}
 *
 * We filter for Visp/Wallis/Valais locations only (pharma hub in Valais).
 *
 * Coopers is a staffing agency — jobs are placed at client companies
 * (typically Lonza, other pharma firms in Visp). The hiring org is
 * Coopers as the recruiter.
 */

const COOPERS_BASE = 'https://www.coopers.ch';
const JOBS_URL = `${COOPERS_BASE}/en/jobs/index.php`;

/** Location keywords that indicate Valais/Visp area. */
const VALAIS_LOCATIONS = ['visp', 'wallis', 'valais', 'brig', 'naters', 'raron', 'gamsen'];

/**
 * Fetch HTML with timeout handling.
 */
async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse DD.MM.YYYY date format → YYYY-MM-DD.
 */
function parseEuDate(raw = '') {
  const m = String(raw).trim().match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/**
 * Check if a location string indicates Valais/Visp area.
 */
function isValaisLocation(location = '') {
  const lower = normalize(location);
  return VALAIS_LOCATIONS.some(kw => lower.includes(kw));
}

/**
 * Parse the Coopers listing page HTML to extract job cards.
 * Each job card has: title, location, contractType, hours, refCode, date, url.
 */
function parseListingPage(html) {
  const listings = [];
  if (!html) return listings;

  // Job entries are blocks with an <h4><a href="/en/jobs/detail.php?refCode=XXX">Title</a></h4>
  // followed by metadata fields (location, type, hours, ref code, date, description)
  const jobBlockPattern = /<h4[^>]*>\s*<a\s+href="(\/en\/jobs\/detail\.php\?refCode=([^"]+))"[^>]*>([\s\S]*?)<\/a>\s*<\/h4>([\s\S]*?)(?=<h4[^>]*>\s*<a\s+href="\/en\/jobs\/detail\.php|$)/gi;
  let match;

  while ((match = jobBlockPattern.exec(html)) !== null) {
    const detailPath = match[1];
    const refCode = match[2];
    const titleHtml = match[3];
    const metaHtml = match[4];

    const title = stripHtml(titleHtml).trim();
    if (!title || title.length < 3) continue;

    // Extract metadata from surrounding text
    const metaText = stripHtml(metaHtml);

    // Location is typically the first identifiable field
    const locationMatch = metaText.match(/(?:Location|Ort|Lieu)[:\s]*([\w\s-]+?)(?:\n|$)/i) ||
      metaText.match(/^([\w\s-]+?)(?:\n|Contracting|Permanent|Full|Part)/m);
    const location = locationMatch ? normalizeSpace(locationMatch[1]) : '';

    // Contract type
    const contractMatch = metaText.match(/\b(Contracting|Permanent|Temporary)\b/i);
    const contractType = contractMatch ? contractMatch[1] : '';

    // Hours
    const hoursMatch = metaText.match(/\b(Full\s*Time|Part\s*Time|\d+\s*%)\b/i);
    const hours = hoursMatch ? hoursMatch[1] : 'Full Time';

    // Posted date
    const dateMatch = metaText.match(/(\d{2}\.\d{2}\.\d{4})/);
    const dateRaw = dateMatch ? dateMatch[1] : '';

    listings.push({
      title,
      location,
      contractType,
      hours,
      refCode,
      postedDate: parseEuDate(dateRaw),
      url: `${COOPERS_BASE}${detailPath}`,
    });
  }

  return listings;
}

/**
 * Fetch and parse a Coopers job detail page for description and requirements.
 */
async function fetchJobDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    if (!html) return { description: '', requirements: [] };

    // Extract main content area
    const descriptionText = stripHtml(html)
      .replace(/^[\s\S]*?(?=About the role|Your role|The Role|Your tasks|Position|For our client)/i, '')
      .replace(/(?:Apply now|Jetzt bewerben|Postuler)[\s\S]*$/i, '')
      .trim();

    // Extract requirements from list items
    const requirements = [];
    const reqSection = html.match(/(?:requirements|qualifications|profile|anforderungen|your profile)[^<]*[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i);
    if (reqSection) {
      const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liPattern.exec(reqSection[1])) !== null) {
        const req = stripHtml(liMatch[1]).trim();
        if (req.length > 3) requirements.push(req);
      }
    }

    return {
      description: descriptionText || '',
      requirements,
    };
  } catch (err) {
    console.warn(`  ⚠️ Error fetching detail: ${err.message}`);
    return { description: '', requirements: [] };
  }
}

/**
 * Normalize Coopers location to a canonical city name.
 */
function normalizeCoopersLocation(raw = '') {
  const lower = normalize(raw);
  if (lower.includes('visp')) return 'Visp';
  if (lower.includes('brig')) return 'Brig';
  if (lower.includes('naters')) return 'Naters';
  if (lower.includes('raron')) return 'Raron';
  return normalizeSpace(raw) || 'Visp';
}

/**
 * Fetch all Coopers Group AG jobs in Valais.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllCoopersJobs() {
  console.log(`🔍 Fetching Coopers Group AG jobs`);
  console.log(`   Source: ${JOBS_URL}`);
  console.log(`   Platform: PHP site (HTML scraping)`);
  console.log(`   Filter: Visp/Wallis/Valais locations\n`);

  // Step 1: Fetch the full listing page
  console.log(`  📄 Fetching listing page...`);
  const listingHtml = await fetchHtml(JOBS_URL);
  const allListings = parseListingPage(listingHtml);

  console.log(`  📋 Total listings on page: ${allListings.length}`);

  // Step 2: Filter to Valais/Visp area only
  const valaisListings = allListings.filter(l => isValaisLocation(l.location));
  console.log(`  🎯 Valais/Visp listings: ${valaisListings.length}`);

  if (valaisListings.length === 0) {
    console.warn('⚠️ No Valais job listings found.');
    return [];
  }

  // Step 3: Fetch detail pages and build job objects
  const jobs = [];
  for (const listing of valaisListings) {
    const title = normalizeSpace(listing.title);
    if (!title || title.length < 3) continue;

    const city = normalizeCoopersLocation(listing.location);
    const canton = inferSwissTargetCanton(city) || 'VS';

    // Fetch detail for description
    console.log(`  📥 Fetching detail: ${title.substring(0, 50)}...`);
    const detail = await fetchJobDetail(listing.url);

    const descriptionText = detail.description || `${title} — ${COOPERS_COMPANY_NAME}, ${city}`;
    const requirements = detail.requirements || [];

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} coopers ${city || 'visp'}`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `coopers-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: COOPERS_COMPANY_NAME,
      companyKey: COOPERS_KEY,
      companyDomain: COOPERS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: listing.url,
      source: 'Coopers Group AG Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Location details ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',

      // ── Job metadata ──
      category: detectCategory(title),
      contract: listing.contractType?.toLowerCase() === 'permanent' ? 'permanent' : 'contracting',
      employmentType: detectEmploymentType(listing.hours || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Farmaceutica / Life Sciences',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: listing.url,

      // ── Requirements ──
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city} (${listing.contractType || 'n/a'})`);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Coopers Group AG Valais jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * JUMBO job parser — Prospective.ch JobBooster API.
 *
 * JUMBO is a Coop Group subsidiary (DIY retail / home improvement).
 * Its career page at jumbo.ch/de/stellen links to the Coop Group's
 * Prospective.ch JobBooster platform:
 *   https://jobs.coopjobs.ch/?f=70:1343965&lang=de
 *
 * API: https://ohws.prospective.ch/public/v1/medium/1000103/jobs
 *   - Medium ID 1000103 = Coop Group career center (shared with Coop, Interdiscount, etc.)
 *   - Company filter: f=70:1343965  (attribute 70 = "Jumbo")
 *   - Canton filter:  f=30:1024526  (attribute 30 = "Wallis" / Valais)
 *
 * No detail page fetching needed — the API returns full descriptions in szas.*.
 * Detail page URL pattern: https://jobs.coopjobs.ch/offene-stellen/{slug}/{viewkey}
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllJumboJobs()     — Fetch and parse all Valais jobs
 *   - isJumboJob()            — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const JUMBO_KEY = 'jumbo';
export const JUMBO_COMPANY_NAME = 'JUMBO';
export const JUMBO_COMPANY_DOMAIN = 'jumbo.ch';

/** Prospective.ch API base for Coop Group career center. */
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000103';

/**
 * Filter IDs for the Prospective.ch API:
 *   Attribute 70 (Unternehmen/Company): 1343965 = Jumbo
 *   Attribute 30 (Kanton/Canton): 1024526 = Wallis/Valais
 */
const COMPANY_FILTER_ID = '1343965';
const CANTON_WALLIS_ID = '1024526';
const API_LIMIT = 100;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert HTML fragments from szas fields to plain-text description.
 * Preserves list structure with bullet points.
 */
function htmlToMarkdown(html = '') {
  if (!html || !html.trim()) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
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
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to JUMBO.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isJumboJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === JUMBO_KEY ||
    key.startsWith('jumbo') ||
    company.includes('jumbo') ||
    url.includes('jumbo.ch') ||
    (url.includes('coopjobs.ch') && company.includes('jumbo'))
  );
}

/**
 * Validate that a URL belongs to JUMBO's trusted domains.
 * JUMBO uses coopjobs.ch (Coop Group portal) and jumbo.ch.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jumbo.ch' ||
      host.endsWith('.jumbo.ch') ||
      host === 'jobs.coopjobs.ch' ||
      host.endsWith('.coopjobs.ch') ||
      host.includes('prospective.ch') ||
      host.includes('successfactors.eu')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', fieldOfActivity = '') {
  const t = normalize(`${title} ${fieldOfActivity}`);
  if (/\b(verkauf|vente|vendita|sales|detail|commerce|retail|filial|caiss)/.test(t)) return 'Commerciale';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|reparatur|garten|jardin)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|sachbearbeit|verwaltung)/.test(t)) return 'Amministrazione';
  if (/\b(logist|magazz|lager|warehouse|warenfluss)/.test(t)) return 'Logistica';
  if (/\b(it\b|software|develop|programm|informatik|sap)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|berufsbildung)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|pr\b)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controlling|kredit)/.test(t)) return 'Finanza';
  if (/\b(category|beschaffung|einkauf|import)/.test(t)) return 'Acquisti';
  if (/\b(leiter|leader|filialleiter|chef|responsab|direktor|fuhrung|kader)/.test(t)) return 'Management';
  return 'Altro';
}

function detectExperienceLevel(title = '', positionType = '') {
  const t = normalize(`${title} ${positionType}`);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|lehrstell|schnupper)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|filialleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(contractType = '', title = '') {
  const t = normalize(`${contractType} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\bunbefristet/.test(t)) return 'FULL_TIME';
  if (/\bbefristet/.test(t)) return 'CONTRACTOR';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Normalize canton code from Prospective.ch region names.
 */
function normalizeCantonCode(regionName = '') {
  const lower = normalize(regionName);
  if (['wallis', 'valais', 'vallese'].some((n) => lower.includes(n))) return 'VS';
  if (['tessin', 'ticino'].some((n) => lower.includes(n))) return 'TI';
  if (['graubünden', 'graubunden', 'grigioni', 'grisons'].some((n) => lower.includes(n))) return 'GR';
  return inferSwissTargetCanton(regionName) || '';
}

/* ── API Client ────────────────────────────────────────────── */

/**
 * Call the Prospective.ch JSON API with timeout handling.
 */
async function callApi(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from Prospective API`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch JUMBO job listings from Prospective.ch API, filtered to Wallis/Valais.
 * Returns the raw API job objects.
 */
async function fetchJobListings() {
  const allListings = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      lang: 'de',
      offset: String(offset),
      limit: String(API_LIMIT),
    });
    // Company filter: Jumbo
    params.append('f', `70:${COMPANY_FILTER_ID}`);
    // Canton filter: Wallis/Valais
    params.append('f', `30:${CANTON_WALLIS_ID}`);

    const apiUrl = `${API_BASE}/jobs?${params}`;
    console.log(`  📄 Fetching JUMBO Wallis jobs (offset=${offset})...`);

    const data = await callApi(apiUrl);
    const items = data?.jobs || [];
    const total = data?.total ?? '?';

    console.log(`  📦 Got ${items.length} jobs (API total: ${total})`);

    if (!Array.isArray(items) || items.length === 0) break;
    allListings.push(...items);
    if (items.length < API_LIMIT) break;
    offset += API_LIMIT;
    await new Promise((r) => setTimeout(r, 300));
  }

  return allListings;
}

/* ── Job Builder ──────────────────────────────────────────── */

/**
 * Build a structured description from Prospective.ch szas fields.
 */
function buildDescription(szas = {}, title = '', city = '') {
  const sections = [];

  const intro = szas.sza_introduction || szas.sza_company_profil || '';
  if (intro) sections.push(htmlToMarkdown(intro));

  const tasks = szas.sza_tasks || '';
  if (tasks) sections.push('## Aufgaben\n' + htmlToMarkdown(tasks));

  const requirements = szas.sza_requirements || '';
  if (requirements) sections.push('## Anforderungen\n' + htmlToMarkdown(requirements));

  const benefits = szas.sza_benefits || '';
  if (benefits) {
    const cleaned = htmlToMarkdown(benefits);
    if (cleaned.length > 5) {
      sections.push('## Wir bieten\n' + cleaned);
    }
  }

  if (sections.length === 0) {
    return `${title} - JUMBO, ${city || 'Wallis'}, Schweiz`;
  }

  return sections.join('\n\n');
}

/**
 * Extract requirements list from szas HTML.
 */
function extractRequirements(szas = {}) {
  const html = szas.sza_requirements || '';
  if (!html) return [];

  return htmlToMarkdown(html)
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line.length > 3);
}

/**
 * Parse pensum (employment percentage) from szas/attributes.
 */
function parsePensum(szas = {}, attrs = {}) {
  const min = szas['sza_pensum.min'] || (attrs['35'] || [])[0] || '';
  const max = szas['sza_pensum.max'] || (attrs['36'] || [])[0] || '';
  const display = szas.sza_pensum || '';

  if (min && max && min !== max) return `${min}-${max}%`;
  if (max) return `${max}%`;
  if (display) return display;
  return '';
}

/**
 * Fetch all JUMBO jobs in Valais/Wallis.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllJumboJobs() {
  console.log(`🔍 Fetching JUMBO jobs`);
  console.log(`   Platform: Prospective.ch JobBooster (Coop Group Career Center)`);
  console.log(`   API: ${API_BASE}/jobs`);
  console.log(`   Filters: Company=Jumbo (70:${COMPANY_FILTER_ID}), Canton=Wallis (30:${CANTON_WALLIS_ID})\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No JUMBO job listings returned from API.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const szas = listing.szas || {};
    const attrs = listing.attributes || {};
    const links = listing.links || {};

    const title = normalizeSpace(szas.sza_title || listing.title || '');
    if (!title || title.length < 3) continue;

    // Location: prefer sza_workplace fields, fall back to sza_location
    const city = normalizeSpace(
      szas['sza_workplace.city'] || szas['sza_location.city'] || ''
    );
    const region = normalizeSpace(
      szas['sza_workplace.region'] || szas['sza_location.region'] || (attrs['30'] || [])[0] || ''
    );
    const postalCode = normalizeSpace(szas['sza_workplace.zip'] || '');
    const street = normalizeSpace(szas['sza_workplace.street'] || '');
    const location = city || region || 'Wallis';
    const canton = normalizeCantonCode(region) || 'VS';

    // Description
    const descriptionText = buildDescription(szas, title, city);
    const requirements = extractRequirements(szas);

    // URLs
    const directLink = (links.directlink || '').trim();
    const applyUrl = (szas.sza_apply_link || '').trim();
    const publicUrl = directLink || 'https://www.jumbo.ch/de/stellen';

    // Employment details
    const contractType = (attrs['40'] || [])[0] || szas.sza_employment_type || '';
    const positionType = (attrs['50'] || [])[0] || szas.sza_role || '';
    const pensum = parsePensum(szas, attrs);
    const fieldOfActivity = szas.sza_field_of_activity || (attrs['20'] || [])[0] || '';

    // Language detection
    const sourceLang = detectLang(descriptionText || title, 'de');

    // Stable ID from viewkey (UUID) — never changes for the same posting
    const viewkey = listing.viewkey || '';
    const stableId = viewkey
      ? `jumbo-${viewkey.slice(0, 12)}`
      : `jumbo-${createHash('sha1').update(publicUrl).digest('hex').slice(0, 12)}`;

    const jobSlug = slugify(`${title} jumbo ${city || 'wallis'}`);

    // Posted date from API start_date
    const postedDate = listing.start_date
      ? new Date(listing.start_date).toISOString().slice(0, 10)
      : new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: stableId,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: JUMBO_COMPANY_NAME,
      companyKey: JUMBO_KEY,
      companyDomain: JUMBO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'JUMBO Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Location details ──
      addressLocality: city || location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      ...(postalCode ? { postalCode } : {}),
      ...(street ? { streetAddress: street } : {}),

      // ── Job metadata ──
      category: detectCategory(title, fieldOfActivity),
      contract: contractType.includes('unbefristet') ? 'permanent' : contractType.includes('befristet') ? 'fixed-term' : 'full-time',
      employmentType: detectEmploymentType(contractType, title),
      experienceLevel: detectExperienceLevel(title, positionType),
      sector: 'Commercio al dettaglio',
      currency: 'CHF',
      featured: false,
      postedDate,
      ...(pensum ? { pensum } : {}),
      ...(applyUrl ? { applyUrl } : { applyUrl: publicUrl }),

      // ── Requirements ──
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city || 'Wallis'}`);
  }

  console.log(`\n📋 Total JUMBO Valais jobs discovered: ${jobs.length}`);
  return jobs;
}

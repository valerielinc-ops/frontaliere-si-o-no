#!/usr/bin/env node
/**
 * Vaxcyte job parser — Greenhouse API fetcher and job builder.
 *
 * Vaxcyte is a clinical-stage vaccine biotech with Swiss operations
 * in Visp (Valais) and Zug. Uses Greenhouse as their ATS.
 *
 * Greenhouse API endpoint:
 *   https://boards-api.greenhouse.io/v1/boards/vaxcyte/jobs?content=true
 *
 * The API returns all jobs globally. We filter for Swiss positions.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllVaxcyteJobs()  — Fetch and parse all Swiss jobs
 *   - isVaxcyteJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  isTargetSwissLocation, inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VAXCYTE_KEY = 'vaxcyte';
export const VAXCYTE_COMPANY_NAME = 'Vaxcyte';
export const VAXCYTE_COMPANY_DOMAIN = 'vaxcyte.com';

const GREENHOUSE_BOARD = 'vaxcyte';
const GREENHOUSE_API = `https://boards-api.greenhouse.io/v1/boards/${GREENHOUSE_BOARD}/jobs?content=true`;
const HQ = getCompanyDefaults(VAXCYTE_KEY);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode common entities.
 */
function htmlToText(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Vaxcyte.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isVaxcyteJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VAXCYTE_KEY ||
    key.startsWith('vaxcyte') ||
    company.includes('vaxcyte') ||
    url.includes('vaxcyte.com') ||
    url.includes('greenhouse.io/vaxcyte')
  );
}

/**
 * Validate that a URL belongs to Vaxcyte's domain or Greenhouse board.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'vaxcyte.com' ||
      host.endsWith('.vaxcyte.com') ||
      host.includes('greenhouse.io')
    );
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
  if (/\b(logist|magazz|lager|warehouse|supply\s*chain|buyer|procurement)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(regulat|regulatory)/.test(t)) return 'Qualità';
  if (/\b(scien|research|r&d|lab)/.test(t)) return 'Ricerca';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|dirett|chef|verantwort|responsab|executive|vice\s*president|vp\b)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Infer employment type from Greenhouse metadata and title.
 * Greenhouse metadata "Worker Sub-Type" values: Regular, Full-time, Temporary, Contract.
 */
function detectEmploymentType(metadata = [], title = '') {
  const workerType = metadata
    .find((m) => m.name === 'Worker Sub-Type')
    ?.value?.toLowerCase() || '';
  if (workerType === 'temporary' || /\bcontract\b/i.test(workerType)) return 'CONTRACTOR';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(normalize(title))) return 'PART_TIME';
  return 'FULL_TIME';
}

/**
 * Parse city name from Greenhouse location string.
 * Example: "Visp, Valais, Switzerland" -> "Visp"
 */
function parseCity(location = '') {
  const parts = String(location || '').split(',').map((s) => s.trim());
  return parts[0] || '';
}

/**
 * Check if any location string in a Greenhouse job matches Switzerland.
 * Returns the first matching Swiss location string, or null.
 */
function findSwissLocation(job) {
  const locationName = job.location?.name || '';
  const offices = job.offices || [];

  const candidates = [
    locationName,
    ...offices.map((o) => o.location || o.name || ''),
  ];

  return candidates.find((loc) => isTargetSwissLocation(loc)) || null;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all jobs from the Greenhouse API.
 * Returns the parsed JSON response.
 */
async function fetchGreenhouseApi() {
  console.log(`   Fetching from Greenhouse API: ${GREENHOUSE_API}`);
  const timeoutMs = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '20000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GREENHOUSE_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`\u26a0\ufe0f HTTP ${res.status} from Greenhouse API`);
      return null;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    console.warn(`\u26a0\ufe0f Greenhouse API fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Build a ParsedJob object from a Greenhouse job entry.
 */
function buildJob(ghJob, swissLocation) {
  const title = normalizeSpace(ghJob.title || '');
  const descriptionHtml = ghJob.content || '';
  const descriptionText = normalizeSpace(htmlToText(descriptionHtml));
  const publicUrl = ghJob.absolute_url || '';

  const city = parseCity(swissLocation);
  const canton = inferAnyCanton(swissLocation) || HQ.canton;
  const departments = (ghJob.departments || []).map((d) => d.name || '').filter(Boolean);

  const datePosted = ghJob.first_published
    ? ghJob.first_published.split('T')[0]
    : ghJob.updated_at
      ? ghJob.updated_at.split('T')[0]
      : new Date().toISOString().split('T')[0];

  const metadata = ghJob.metadata || [];
  const employmentType = detectEmploymentType(metadata, title);
  const isContract = employmentType === 'CONTRACTOR' || /\bcontract\b/i.test(title);

  const sourceLang = detectLang(descriptionText || title, 'en');
  const jobSlug = slugify(`${title} vaxcyte ch`);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

  return {
    // ── Required fields ──
    id: `vaxcyte-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: VAXCYTE_COMPANY_NAME,
    companyKey: VAXCYTE_KEY,
    companyDomain: VAXCYTE_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText || `${title} — Vaxcyte`,
    descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Vaxcyte` },
    location: city || HQ.city,
    canton,
    url: publicUrl,
    source: 'Vaxcyte Dedicated Parser',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: city || HQ.city,
    addressRegion: canton,
    addressCountry: 'CH',
    postalCode: HQ.postalCode,
    country: 'CH',
    category: detectCategory(title),
    contract: isContract ? 'contract' : 'full-time',
    employmentType: employmentType === 'CONTRACTOR' ? 'FULL_TIME' : employmentType,
    experienceLevel: detectExperienceLevel(title),
    sector: 'Biotecnologia / Farmaceutica',
    currency: 'CHF',
    featured: false,
    postedDate: datePosted,
    applyUrl: publicUrl,
    department: departments.join(', '),
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
    _targetScope: { canton, location: city || HQ.city },
  };
}

/**
 * Fetch all Vaxcyte jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllVaxcyteJobs() {
  console.log(`\ud83d\udd0d Fetching Vaxcyte jobs`);
  console.log(`   Source: ${GREENHOUSE_API}\n`);

  const apiResponse = await fetchGreenhouseApi();
  if (!apiResponse || !Array.isArray(apiResponse.jobs)) {
    console.warn('\u26a0\ufe0f No job listings returned from Greenhouse API.');
    return [];
  }

  console.log(`  \ud83d\udccb Total Greenhouse listings: ${apiResponse.jobs.length}`);

  const jobs = [];
  const seen = new Set();

  for (const ghJob of apiResponse.jobs) {
    if (!ghJob.title || !ghJob.id) continue;

    // Skip generic "don't see a role" catch-all entries
    if (/don.t see a role/i.test(ghJob.title)) continue;

    // Check for Swiss location
    const swissLocation = findSwissLocation(ghJob);
    if (!swissLocation) continue;

    // Deduplicate by Greenhouse ID
    if (seen.has(ghJob.id)) continue;
    seen.add(ghJob.id);

    const title = normalizeSpace(ghJob.title);
    if (!title || title.length < 3) continue;

    const job = buildJob(ghJob, swissLocation);
    jobs.push(job);
  }

  console.log(`  \ud83c\udfaf Swiss jobs found: ${jobs.length} (of ${apiResponse.jobs.length} total)`);
  console.log(`\n\ud83d\udccb Total Vaxcyte jobs discovered: ${jobs.length}`);
  return jobs;
}

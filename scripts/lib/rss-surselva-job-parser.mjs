#!/usr/bin/env node
/**
 * Regionalspital Surselva (RSS) job parser — Ostendis JobPublisher API.
 *
 * Source: https://www.rss.ch/jobs-und-karriere/offene-stellen/
 *
 * RSS uses an Ostendis JobPublisher widget to display job listings.
 * The widget loads from a JSON API at odm.ostendis.com, returning
 * structured job data. Detail pages at link.ostendis.com contain
 * JSON-LD (schema.org/JobPosting) with full descriptions.
 *
 * API endpoint:
 *   GET https://odm.ostendis.com/ojp/data/v54/jobs/{token}/DE?domain=www.rss.ch
 *
 * Detail pages:
 *   https://link.ostendis.com/publication/{slug}/{hash}
 *   → contain JSON-LD with datePosted, employmentType, description, location
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRssSurselvaJobs()  — Fetch and parse all jobs
 *   - isRssSurselvaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to this company
 *   - slugify() / stripHtml()    — Re-exported from crawler-template.mjs
 *
 * Also exports helpers for testing:
 *   - parseOstendisJob()         — Parse a single Ostendis API job entry
 *   - parseDetailPageJsonLd()    — Extract JSON-LD from detail page HTML
 *   - detectCategory()           — Detect job category from title/department
 *   - detectExperienceLevel()    — Detect experience level from title
 *   - inferEmploymentType()      — Infer FULL_TIME/PART_TIME from title
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RSS_SURSELVA_KEY = 'rss-surselva';
export const RSS_SURSELVA_COMPANY_NAME = 'Regionalspital Surselva';
export const RSS_SURSELVA_COMPANY_DOMAIN = 'rss.ch';

const CAREER_URL = 'https://www.rss.ch/jobs-und-karriere/offene-stellen/';

/**
 * Ostendis JobPublisher API configuration.
 * The publication place hash is embedded in the WordPress page and identifies
 * this company's job widget instance.
 */
const OSTENDIS_API_BASE = 'https://odm.ostendis.com/ojp/data/v54/jobs';
const OSTENDIS_TOKEN = '34730e00e7954717af493651013ec260';
const OSTENDIS_LANG = 'DE';
const OSTENDIS_DOMAIN = 'www.rss.ch';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Regionalspital Surselva.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRssSurselvaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RSS_SURSELVA_KEY ||
    key.startsWith('rss-surselva') ||
    company.includes('regionalspital surselva') ||
    url.includes('rss.ch')
  );
}

/**
 * Validate that a URL belongs to RSS's domain or Ostendis (ATS).
 * RSS jobs link to both rss.ch and ostendis.com (detail + apply pages).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'rss.ch' ||
      host.endsWith('.rss.ch') ||
      host === 'link.ostendis.com' ||
      host === 'odm.ostendis.com' ||
      host.endsWith('.ostendis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect job category from title and department.
 * RSS is a hospital — categories are healthcare-oriented.
 */
export function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const combined = `${t} ${d}`;

  // Order matters: specific compound terms BEFORE their generic roots.
  // "Arztsekretär" must match admin before "Arzt" matches medicine.
  // "Lehrperson"/"Lernende" must match training before "Pflege" matches nursing.
  if (/\b(arztsekret|sekretär|admin|verwaltung|controlling|buchhalt|empfang|rezept)/.test(combined)) return 'Amministrazione';
  if (/\b(lehrer|lehrperson|lernend|schul|ausbildung|apprenti|lehrling)/.test(combined)) return 'Formazione';
  if (/\b(arzt|ärztin|ober[aä]rzt|medizin|psychiater|pädia|chirurg|anästh|gynäkolog|internist)/.test(combined)) return 'Medicina';
  if (/\b(pflege|fachperson gesundheit|fage|betreu|hebamme|stillberater|geburts)/.test(combined)) return 'Infermieristica';
  if (/\b(psycholog|psycho)/.test(combined)) return 'Psicologia';
  if (/\b(sozial|sozialpädagog|agog)/.test(combined)) return 'Sociale';
  if (/\b(physio|ergo|therapi|logopäd|diät)/.test(combined)) return 'Terapia';
  if (/\b(apothek|pharma)/.test(combined)) return 'Farmacia';
  if (/\b(labor|biomedizin|mtla|radiolog|röntgen|mtra)/.test(combined)) return 'Laboratorio';
  if (/\b(hotellerie|küche|raumpflege|gastro|koch|hauswirt|reinig|wäsche|ling)/.test(combined)) return 'Ristorazione';
  if (/\b(techni|mecanic|elektr|install|haustechnik|facility|betrieb)/.test(combined)) return 'Tecnica';
  if (/\b(it|software|informatik|develop)/.test(combined)) return 'IT';
  if (/\b(hr|human|personal)/.test(combined)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(combined)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(combined)) return 'Finanza';
  return 'Sanità';
}

export function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|oberarzt|oberärztin|stv)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Infer employment type from title (percentage patterns).
 * Ostendis API often has empty workload fields; the title contains "80-100 %" etc.
 */
export function inferEmploymentType(title = '') {
  const t = normalize(title);
  // Match patterns like "80-100%", "80 - 100 %", "50-100%"
  const rangeMatch = t.match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (rangeMatch) {
    const max = parseInt(rangeMatch[2], 10);
    return max >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  // Match single percentage like "100%", "50%"
  const singleMatch = t.match(/(\d+)\s*%/);
  if (singleMatch) {
    const pct = parseInt(singleMatch[1], 10);
    return pct >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  return 'FULL_TIME'; // Hospital jobs default to full-time
}

/* ── Ostendis API Client ──────────────────────────────────── */

/**
 * Fetch job listings from the Ostendis JobPublisher API.
 * Returns the raw API response (jobs array + metadata).
 */
async function fetchOstendisListings() {
  const url = `${OSTENDIS_API_BASE}/${OSTENDIS_TOKEN}/${OSTENDIS_LANG}?domain=${OSTENDIS_DOMAIN}`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from Ostendis API`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Detail Page Fetcher ──────────────────────────────────── */

/**
 * Fetch a job detail page from link.ostendis.com and extract the
 * JSON-LD structured data for richer descriptions.
 */
async function fetchDetailPage(detailUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(detailUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from detail page: ${detailUrl}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Extract JSON-LD JobPosting data from a detail page HTML string.
 * Returns { description, datePosted, employmentType, streetAddress,
 *           addressLocality, postalCode, addressRegion }.
 */
export function parseDetailPageJsonLd(html = '') {
  const result = {
    description: '',
    datePosted: '',
    employmentType: '',
    streetAddress: '',
    addressLocality: '',
    postalCode: '',
    addressRegion: '',
  };

  // Extract JSON-LD block
  const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!jsonLdMatch) return result;

  try {
    const data = JSON.parse(jsonLdMatch[1]);
    if (data['@type'] !== 'JobPosting') return result;

    // Extract description (HTML → plain text)
    if (data.description) {
      result.description = normalizeSpace(stripHtml(data.description));
    }

    // datePosted
    if (data.datePosted) {
      result.datePosted = data.datePosted;
    }

    // employmentType (can be array or string)
    if (data.employmentType) {
      const types = Array.isArray(data.employmentType) ? data.employmentType : [data.employmentType];
      if (types.includes('FULL_TIME') && types.includes('PART_TIME')) {
        result.employmentType = 'FULL_TIME';
      } else if (types.includes('FULL_TIME')) {
        result.employmentType = 'FULL_TIME';
      } else if (types.includes('PART_TIME')) {
        result.employmentType = 'PART_TIME';
      }
    }

    // Location from jobLocation.address
    const address = data.jobLocation?.address;
    if (address) {
      result.streetAddress = address.streetAddress || '';
      result.addressLocality = address.addressLocality || '';
      result.postalCode = address.postalCode || '';
      result.addressRegion = address.addressRegion || '';
    }
  } catch {
    // JSON parse failure — return defaults
  }

  return result;
}

/* ── Job Parsing ──────────────────────────────────────────── */

/**
 * Parse a single Ostendis API job entry into a ParsedJob object.
 * The Ostendis API returns: { id, title, city, zip, department, detail, action,
 *   country, countrycode, workload, workload_min, workload_max, timestamp, ... }
 *
 * @param {object} entry - Raw Ostendis API job object
 * @param {object} detailData - Parsed JSON-LD from the detail page (optional)
 * @returns {object|null} ParsedJob or null if invalid
 */
export function parseOstendisJob(entry, detailData = {}) {
  const title = normalizeSpace(entry.title || '');
  if (!title || title.length < 3) return null;

  const location = normalizeSpace(entry.city || detailData.addressLocality || 'Ilanz');
  const canton = inferSwissTargetCanton(location) || detailData.addressRegion || 'GR';

  // Use detail page URL as the public URL (human-readable job page)
  const publicUrl = entry.detail || CAREER_URL;
  const applyUrl = entry.action || publicUrl;

  // Generate stable ID from Ostendis job ID
  const idSource = entry.id ? String(entry.id) : publicUrl;
  const urlHash = createHash('sha1').update(idSource).digest('hex').slice(0, 12);

  // Build description: prefer detail page JSON-LD, fall back to title-based + company boilerplate
  let descriptionText = detailData.description || '';
  if (!descriptionText || descriptionText.length < 150) {
    // Detail page description too short or missing — build from metadata + company boilerplate
    const parts = [`${title} — Regionalspital Surselva (RSS)`];
    if (entry.department) parts.push(`Abteilung: ${entry.department}`);
    parts.push(`Arbeitsort: ${location} (${canton})`);
    parts.push('Die Regionalspital Surselva AG ist ein regional verankertes Spital in Ilanz und stellt die erweiterte Grund- und Notfallversorgung für rund 22\'000 Einwohner und saisonal 20\'000 Feriengäste der Region Surselva sicher');
    descriptionText = parts.join('. ');
  }

  // Employment type: detail page → title-based inference
  let employmentType = detailData.employmentType || inferEmploymentType(title);

  // Determine contract type from percentage in title
  const rangeMatch = normalize(title).match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  const singleMatch = normalize(title).match(/(\d+)\s*%/);
  let pensumMin, pensumMax, pensum;
  if (rangeMatch) {
    pensumMin = parseInt(rangeMatch[1], 10);
    pensumMax = parseInt(rangeMatch[2], 10);
    pensum = pensumMin === pensumMax ? `${pensumMin}%` : `${pensumMin} - ${pensumMax}%`;
  } else if (singleMatch) {
    pensumMin = parseInt(singleMatch[1], 10);
    pensumMax = pensumMin;
    pensum = `${pensumMin}%`;
  }

  const contract = (pensumMax && pensumMax < 90) ? 'part-time' : 'full-time';

  const sourceLang = 'de';
  const jobSlug = slugify(`${title} rss-surselva ch`);

  const postalCode = entry.zip || detailData.postalCode || '7130';
  const streetAddress = detailData.streetAddress || 'Spitalstrasse 6';
  const datePosted = detailData.datePosted || new Date().toISOString().split('T')[0];

  return {
    // ── Required fields ──
    id: `rss-surselva-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: RSS_SURSELVA_COMPANY_NAME,
    companyKey: RSS_SURSELVA_KEY,
    companyDomain: RSS_SURSELVA_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText,
    descriptionByLocale: { [sourceLang]: descriptionText },
    location,
    canton,
    url: publicUrl,
    source: 'Regionalspital Surselva Dedicated Parser',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: location,
    postalCode,
    streetAddress,
    addressCountry: 'CH',
    country: 'CH',
    category: detectCategory(title, entry.department || ''),
    contract,
    employmentType,
    experienceLevel: detectExperienceLevel(title),
    sector: 'Sanità / Assistenza',
    currency: 'CHF',
    featured: false,
    postedDate: datePosted,
    applyUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },

    // ── Optional enrichment ──
    ...(entry.department ? { department: entry.department } : {}),
    ...(pensum ? { pensum, pensumMin, pensumMax } : {}),
  };
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Regionalspital Surselva jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Call the Ostendis JobPublisher API for the job listing
 *   2. For each job, fetch the detail page for JSON-LD enrichment
 *   3. Build ParsedJob objects with all available metadata
 */
export async function fetchAllRssSurselvaJobs() {
  console.log(`🔍 Fetching Regionalspital Surselva jobs`);
  console.log(`   Source: Ostendis JobPublisher API\n`);

  const data = await fetchOstendisListings();
  const listings = data?.jobs;

  if (!listings || !Array.isArray(listings) || listings.length === 0) {
    console.warn('⚠️ No job listings returned from Ostendis API.');
    if (data?.error?.message) {
      console.warn(`   API error: ${data.error.message}`);
    }
    return [];
  }

  console.log(`  📋 Ostendis listings found: ${listings.length}`);

  const jobs = [];
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 500;

  for (const entry of listings) {
    const title = normalizeSpace(entry.title || '');
    if (!title || title.length < 3) continue;

    // Fetch detail page for JSON-LD enrichment
    let detailData = {};
    if (entry.detail) {
      try {
        const detailHtml = await fetchDetailPage(entry.detail);
        detailData = parseDetailPageJsonLd(detailHtml);
        await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        console.warn(`  ⚠️ Failed to fetch detail for "${title}": ${err.message}`);
      }
    }

    const job = parseOstendisJob(entry, detailData);
    if (!job) continue;

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 60)} — ${job.location} (${job.employmentType})`);
  }

  console.log(`\n📋 Total Regionalspital Surselva jobs discovered: ${jobs.length}`);
  return jobs;
}

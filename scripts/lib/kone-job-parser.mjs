#!/usr/bin/env node
/**
 * KONE job parser — Fetcher and job builder.
 *
 * Source: https://careers.kone.com/en/find-jobs/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKoneJobs()  — Fetch and parse all jobs
 *   - isKoneJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KONE_KEY = 'kone';
export const KONE_COMPANY_NAME = 'KONE';
export const KONE_COMPANY_DOMAIN = 'kone.com';

const CAREER_URL = 'https://careers.kone.com/en/find-jobs/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to KONE.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKoneJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KONE_KEY ||
    key.startsWith('kone') ||
    company.includes('kone') ||
    url.includes('kone.com')
  );
}

/**
 * Validate that a URL belongs to KONE's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'kone.com' || host.endsWith('.kone.com');
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

/* ── SmartRecruiters API Client ────────────────────────────── */

/**
 * SmartRecruiters public API for KONE.
 * Company ID: KONE1
 * Listing: GET /v1/companies/KONE1/postings?limit=N&offset=N&country=CH
 * Detail:  GET /v1/companies/KONE1/postings/{id}
 */
const SR_API_BASE = 'https://api.smartrecruiters.com/v1/companies/KONE1';
const PAGE_SIZE = 100;

/**
 * Fetch JSON from the SmartRecruiters API with timeout handling.
 */
async function fetchJson(url) {
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
    if (!res.ok) throw new Error(`HTTP ${res.status} from SmartRecruiters API`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Convert SmartRecruiters jobAd HTML sections to plain text description.
 */
function buildDescription(sections = {}) {
  const order = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'];
  const headings = {
    jobDescription: null,
    qualifications: 'Requirements',
    additionalInformation: 'What we offer',
    companyDescription: 'About KONE',
  };

  const parts = [];
  for (const key of order) {
    const section = sections[key];
    if (!section?.text) continue;
    const text = stripHtml(section.text);
    if (!text) continue;
    const heading = headings[key];
    parts.push(heading ? `${heading}:\n${text}` : text);
  }
  return parts.join('\n\n').trim();
}

/**
 * Extract requirements from the qualifications section HTML.
 */
function extractRequirements(sections = {}) {
  const qualHtml = sections?.qualifications?.text || '';
  if (!qualHtml) return [];
  const items = [...qualHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => stripHtml(m[1]).trim())
    .filter((s) => s.length > 3);
  return items.slice(0, 10);
}

/**
 * Fetch paginated job listings from SmartRecruiters, filtered to Switzerland.
 */
async function fetchJobListings() {
  const allListings = [];
  let offset = 0;

  while (true) {
    const url = `${SR_API_BASE}/postings?limit=${PAGE_SIZE}&offset=${offset}&country=CH`;
    console.log(`  📄 Fetching SmartRecruiters listings (offset=${offset})...`);
    const data = await fetchJson(url);
    const items = data?.content || [];
    const total = data?.totalFound ?? '?';

    console.log(`  📦 Got ${items.length} postings (API total: ${total})`);

    if (!Array.isArray(items) || items.length === 0) break;
    allListings.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 300));
  }

  return allListings;
}

/**
 * Fetch full detail for a single posting from SmartRecruiters API.
 */
async function fetchJobDetail(postingId) {
  const url = `${SR_API_BASE}/postings/${postingId}`;
  try {
    return await fetchJson(url);
  } catch (err) {
    console.warn(`  ⚠️ Failed to fetch detail for ${postingId}: ${err?.message}`);
    return null;
  }
}

/**
 * Fetch all KONE jobs in Switzerland from SmartRecruiters.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllKoneJobs() {
  console.log(`🔍 Fetching KONE jobs from SmartRecruiters API`);
  console.log(`   API: ${SR_API_BASE}/postings`);
  console.log(`   Filter: country=CH\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss KONE job listings returned from SmartRecruiters.');
    return [];
  }

  console.log(`\n  📋 Swiss listings found: ${listings.length}. Fetching details...\n`);

  const jobs = [];
  for (const listing of listings) {
    const postingId = listing.id || listing.uuid;
    if (!postingId) continue;

    // Fetch full detail for richer description
    const detail = await fetchJobDetail(postingId);
    const sections = detail?.jobAd?.sections || {};

    const title = normalizeSpace(detail?.name || listing.name || '');
    if (!title || title.length < 3) continue;

    // Location from listing or detail
    const loc = detail?.location || listing.location || {};
    const city = normalizeSpace(loc.city || '');
    const region = normalizeSpace(loc.region || '');
    const location = city || region || 'Switzerland';
    const canton = inferSwissTargetCanton(location) || 'VS';

    // Description
    const descriptionText = buildDescription(sections);
    const requirements = extractRequirements(sections);

    // Public URL — SmartRecruiters provides an apply URL
    const publicUrl = detail?.applyUrl || `${CAREER_URL}`;
    const refNumber = detail?.refNumber || listing.refNumber || '';

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} kone ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = (detail?.releasedDate || listing.releasedDate || '')
      .split('T')[0] || new Date().toISOString().split('T')[0];
    const employmentType = detectEmploymentType(
      detail?.typeOfEmployment || listing.typeOfEmployment || title
    );

    const job = {
      // ── Required fields ──
      id: `kone-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KONE_COMPANY_NAME,
      companyKey: KONE_KEY,
      companyDomain: KONE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — KONE`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — KONE` },
      location,
      canton,
      url: publicUrl,
      source: 'KONE Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ingegneria / Ascensori',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
    };

    if (refNumber) job.refNumber = refNumber;

    jobs.push(job);
    console.log(`  ✅ ${refNumber || postingId} — ${title.substring(0, 60)}`);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total KONE Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}

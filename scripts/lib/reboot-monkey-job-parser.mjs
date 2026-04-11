#!/usr/bin/env node
/**
 * Reboot Monkey job parser — JSON API fetcher and job builder.
 *
 * Reboot Monkey is a data center services company headquartered in Visp (VS).
 * They post data center technician and IT jobs across Switzerland via a
 * Recruitee-powered JSON API.
 *
 * API: https://www.rebootmonkey.com/api/jobs?country=CH
 *   - Paginated JSON: { total, count, page, pages, limit, offset, results[] }
 *   - Supports: ?country=CH (filter Swiss jobs), ?page=N, ?limit=N (max 100)
 *   - Each result has: id, title, slug, description (HTML), requirements (HTML),
 *     city, country_code, employment_type, department, url, created_at, etc.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRebootMonkeyJobs()  — Fetch and parse all Swiss jobs
 *   - isRebootMonkeyJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const REBOOT_MONKEY_KEY = 'reboot-monkey';
export const REBOOT_MONKEY_COMPANY_NAME = 'Reboot Monkey';
export const REBOOT_MONKEY_COMPANY_DOMAIN = 'rebootmonkey.com';

const CAREER_URL = 'https://www.rebootmonkey.com/en/jobs';
const API_BASE = 'https://www.rebootmonkey.com/api/jobs';
const PAGE_SIZE = 100;
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const HQ = getCompanyDefaults(REBOOT_MONKEY_KEY);

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Reboot Monkey.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isRebootMonkeyJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === REBOOT_MONKEY_KEY ||
    key.startsWith('reboot-monkey') ||
    company.includes('reboot monkey') ||
    url.includes('rebootmonkey.com')
  );
}

/**
 * Validate that a URL belongs to Reboot Monkey's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'rebootmonkey.com' || host.endsWith('.rebootmonkey.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(`${title} ${department}`);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|data.center)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|coordinator)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(project.manag)/.test(t)) return 'IT';
  return 'Altro';
}

function detectExperienceLevel(title = '', experienceLevel = '') {
  const t = normalize(`${title} ${experienceLevel}`);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|entry)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map Recruitee employment_type values to schema.org EmploymentType.
 *   API values: "full_time", "fulltime", "fulltime_fixed_term", "freelance", "part_time"
 */
function mapEmploymentType(apiType = '') {
  const t = normalize(apiType);
  if (t.includes('part_time') || t.includes('part-time')) return 'PART_TIME';
  if (t.includes('full_time') || t.includes('fulltime') || t.includes('full-time')) return 'FULL_TIME';
  if (t.includes('freelance') || t.includes('contract') || t.includes('contractor')) return 'CONTRACTOR';
  if (t.includes('intern') || t.includes('stage')) return 'INTERN';
  if (t.includes('temporary') || t.includes('temp')) return 'TEMPORARY';
  return 'OTHER';
}

/**
 * Map Recruitee employment_type to a human-readable contract string.
 */
function mapContract(apiType = '') {
  const t = normalize(apiType);
  if (t.includes('freelance')) return 'freelance';
  if (t.includes('part_time') || t.includes('part-time')) return 'part-time';
  if (t.includes('full_time') || t.includes('fulltime') || t.includes('full-time')) return 'full-time';
  if (t.includes('intern') || t.includes('stage')) return 'internship';
  return 'full-time';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch one page of Swiss jobs from the Reboot Monkey API.
 */
async function fetchJobPage(page = 1) {
  const url = `${API_BASE}?country=CH&limit=${PAGE_SIZE}&page=${page}`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from Reboot Monkey API`);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch all Swiss job listings by paginating through the API.
 */
async function fetchJobListings() {
  console.log(`   API: ${API_BASE}?country=CH`);

  const firstPage = await fetchJobPage(1);
  const total = firstPage.total || 0;
  const totalPages = firstPage.pages || 1;

  console.log(`   Total Swiss jobs: ${total} across ${totalPages} page(s)`);

  if (total === 0) return [];

  const allListings = [...(firstPage.results || [])];
  console.log(`   Page 1: ${firstPage.count} jobs`);

  for (let page = 2; page <= totalPages; page++) {
    await new Promise((r) => setTimeout(r, 400));
    const data = await fetchJobPage(page);
    const results = data.results || [];
    allListings.push(...results);
    console.log(`   Page ${page}: ${results.length} jobs (total so far: ${allListings.length})`);
    if (results.length === 0) break;
  }

  return allListings;
}

/**
 * Extract requirements as a list of strings from the HTML requirements field.
 */
function parseRequirements(html = '') {
  if (!html) return [];
  const text = stripHtml(html);
  return text
    .split('\n')
    .map((line) => normalizeSpace(line.replace(/^[-•*]\s*/, '')))
    .filter((line) => line.length > 5);
}

/**
 * Build a combined description from description + requirements HTML fields.
 */
function buildDescription(listing) {
  const parts = [];

  const descText = stripHtml(listing.description || '');
  if (descText) parts.push(descText);

  const reqText = stripHtml(listing.requirements || '');
  if (reqText) parts.push(`Requirements:\n${reqText}`);

  return parts.join('\n\n') || normalizeSpace(listing.title || '');
}

/**
 * Fetch all Reboot Monkey jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllRebootMonkeyJobs() {
  console.log(`🔍 Fetching Reboot Monkey jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`\n  📋 Listings found: ${listings.length}`);

  // Deduplicate by API id (the API may return duplicates across pages)
  const seenIds = new Set();
  const uniqueListings = [];
  for (const listing of listings) {
    const apiId = String(listing.id || '');
    if (!apiId || seenIds.has(apiId)) continue;
    seenIds.add(apiId);
    uniqueListings.push(listing);
  }

  if (uniqueListings.length < listings.length) {
    console.log(`   Deduplicated: ${listings.length} → ${uniqueListings.length}`);
  }

  const jobs = [];
  for (const listing of uniqueListings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const city = normalizeSpace(listing.city || '').replace(/^\s+/, '');
    const location = city || HQ.city;
    const canton = inferAnyCanton(city || location) || HQ.canton;

    const description = buildDescription(listing);
    const requirements = parseRequirements(listing.requirements || '');

    // Reboot Monkey posts are in English
    const sourceLang = detectLang(description || title, 'en');

    const publicUrl = listing.url || `${CAREER_URL}/${listing.slug || ''}`;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} reboot-monkey ${city || 'ch'}`);

    const postedDate = listing.created_at
      ? listing.created_at.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const apiEmploymentType = listing.employment_type || '';

    const job = {
      // ── Required fields ──
      id: `reboot-monkey-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: REBOOT_MONKEY_COMPANY_NAME,
      companyKey: REBOOT_MONKEY_KEY,
      companyDomain: REBOOT_MONKEY_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Reboot Monkey Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department || ''),
      contract: mapContract(apiEmploymentType),
      employmentType: mapEmploymentType(apiEmploymentType),
      experienceLevel: detectExperienceLevel(title, listing.experience_level || ''),
      sector: 'Tecnologia / Data Center',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: listing.careers_apply_url || publicUrl,
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
      remote: !!listing.remote,
    };

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 60)} — ${location}`);
  }

  console.log(`\n📋 Total Reboot Monkey jobs discovered: ${jobs.length}`);
  return jobs;
}

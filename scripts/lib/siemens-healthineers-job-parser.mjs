#!/usr/bin/env node
/**
 * Siemens Healthineers job parser — Fetcher and job builder.
 *
 * Source: https://careers.siemens-healthineers.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSiemensHealthineersJobs()  — Fetch and parse all jobs
 *   - isSiemensHealthineersJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SIEMENS_HEALTHINEERS_KEY = 'siemens-healthineers';
export const SIEMENS_HEALTHINEERS_COMPANY_NAME = 'Siemens Healthineers';
export const SIEMENS_HEALTHINEERS_COMPANY_DOMAIN = 'siemens-healthineers.com';

const CAREER_URL = 'https://careers.siemens-healthineers.com/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Siemens Healthineers.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSiemensHealthineersJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SIEMENS_HEALTHINEERS_KEY ||
    key.startsWith('siemens-healthineers') ||
    company.includes('siemens healthineers') ||
    url.includes('siemens-healthineers.com')
  );
}

/**
 * Validate that a URL belongs to Siemens Healthineers's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'siemens-healthineers.com' || host.endsWith('.siemens-healthineers.com');
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

/* ── Phenom People Platform Integration ───────────────────── */

/**
 * Siemens Healthineers uses the Phenom People ATS platform.
 * Jobs are embedded in the phApp.ddo.eagerLoadRefineSearch.data.jobs
 * array on the search results page.
 *
 * Search URL pattern:
 *   https://careers.siemens-healthineers.com/global/en/search-results?keywords=&location=Switzerland
 *
 * Detail URL pattern:
 *   https://careers.siemens-healthineers.com/global/en/job/{jobSeqNo}/{slug}
 *
 * The phApp.ddo object fields per job:
 *   jobId, reqId, title, city, state, country, cityStateCountry,
 *   category, postedDate, jobSeqNo, type, descriptionTeaser, applyUrl,
 *   latitude, longitude, address, workerSubType, ml_skills
 */

const SEARCH_URL = 'https://careers.siemens-healthineers.com/global/en/search-results';
const DETAIL_BASE = 'https://careers.siemens-healthineers.com/global/en/job';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Swiss location patterns relevant for Valais / western Switzerland.
 * We filter for jobs physically based in Switzerland.
 */
const SWISS_LOCATION_PATTERNS = [
  'switzerland', 'suisse', 'schweiz', 'svizzera',
  'zurich', 'zürich', 'bern', 'basel', 'geneva', 'genève',
  'lausanne', 'lucerne', 'luzern', 'st. gallen',
  'sion', 'sierre', 'visp', 'brig', 'valais', 'wallis',
  'zug', 'winterthur', 'aarau', 'olten',
];

function isSwissLocation(text = '') {
  const t = String(text || '').toLowerCase();
  return SWISS_LOCATION_PATTERNS.some((p) => t.includes(p));
}

function slugifyTitle(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

/**
 * Extract the phApp.ddo JSON object from the Phenom People HTML.
 */
function extractPhenomDdo(html = '') {
  const match = String(html || '').match(
    /phApp\.ddo\s*=\s*(\{[\s\S]*?\})\s*;\s*phApp\.experimentData/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Fetch the search results page HTML and extract jobs from phApp.ddo.
 * Tries multiple location queries to maximize Swiss job coverage.
 */
async function fetchSearchPage(location = 'Switzerland') {
  const url = `${SEARCH_URL}?keywords=&location=${encodeURIComponent(location)}&radius=100`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from Phenom search page`);
    const html = await res.text();

    const ddo = extractPhenomDdo(html);
    const jobs = ddo?.eagerLoadRefineSearch?.data?.jobs;
    if (!Array.isArray(jobs)) return [];

    return jobs.map((job) => ({
      reqId: String(job.reqId || job.jobId || '').trim(),
      jobId: String(job.jobId || job.reqId || '').trim(),
      title: normalizeSpace(job.title || ''),
      city: normalizeSpace(job.city || ''),
      state: normalizeSpace(job.state || ''),
      country: normalizeSpace(job.country || ''),
      cityStateCountry: normalizeSpace(job.cityStateCountry || ''),
      address: normalizeSpace(job.address || ''),
      category: Array.isArray(job.multi_category)
        ? normalizeSpace(job.multi_category[0] || '')
        : normalizeSpace(job.category || ''),
      type: normalizeSpace(job.type || ''),
      postedDate: String(job.postedDate || '').trim(),
      descriptionTeaser: String(job.descriptionTeaser || '').trim(),
      applyUrl: String(job.applyUrl || '').trim(),
      jobSeqNo: String(job.jobSeqNo || '').trim(),
    })).filter((j) => j.reqId && j.title);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch a detail page for richer description via JSON-LD.
 */
async function fetchDetailPage(jobSeqNo, title) {
  const detailUrl = `${DETAIL_BASE}/${encodeURIComponent(jobSeqNo)}/${slugifyTitle(title)}`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(detailUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': USER_AGENT,
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { url: detailUrl, description: '' };
    const html = await res.text();

    let description = '';
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(ldMatch[1]);
        const items = Array.isArray(data) ? data : [data];
        const posting = items.find((i) => i?.['@type'] === 'JobPosting');
        if (posting?.description) {
          description = stripHtml(posting.description);
          break;
        }
      } catch { /* ignore */ }
    }

    return { url: detailUrl, description };
  } catch {
    return { url: `${DETAIL_BASE}/${encodeURIComponent(jobSeqNo)}/${slugifyTitle(title)}`, description: '' };
  }
}

/**
 * Fetch all Siemens Healthineers Swiss jobs from the Phenom People platform.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch search page with location=Switzerland
 *   2. Also try location=Zurich, location=Valais for broader coverage
 *   3. Deduplicate by jobId
 *   4. Fetch detail pages for richer descriptions
 *   5. Build ParsedJob objects
 */
export async function fetchAllSiemensHealthineersJobs() {
  console.log(`🔍 Fetching Siemens Healthineers jobs`);
  console.log(`   Source: ${SEARCH_URL}\n`);

  // Try multiple location queries to maximize coverage
  const searchLocations = ['Switzerland', 'Zurich', 'Valais'];
  const allJobs = new Map();

  for (const loc of searchLocations) {
    try {
      console.log(`  📄 Searching location: ${loc}...`);
      const results = await fetchSearchPage(loc);
      for (const job of results) {
        if (!allJobs.has(job.reqId)) {
          allJobs.set(job.reqId, job);
        }
      }
      console.log(`     Found ${results.length} jobs (total unique: ${allJobs.size})`);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn(`  ⚠️ Search for "${loc}" failed: ${err?.message}`);
    }
  }

  // Filter for Swiss locations only
  const swissJobs = [...allJobs.values()].filter((job) => {
    const locationText = `${job.city} ${job.state} ${job.country} ${job.cityStateCountry} ${job.address}`;
    return isSwissLocation(locationText);
  });

  console.log(`\n  🇨🇭 Swiss jobs: ${swissJobs.length}`);

  if (swissJobs.length === 0) {
    console.warn('⚠️ No Swiss job listings found.');
    return [];
  }

  const jobs = [];
  for (const listing of swissJobs) {
    const title = listing.title;
    if (!title || title.length < 3) continue;

    // Fetch detail page for description
    let detailInfo = { url: '', description: '' };
    if (listing.jobSeqNo) {
      try {
        detailInfo = await fetchDetailPage(listing.jobSeqNo, title);
        console.log(`  ✅ ${title.substring(0, 60)}`);
      } catch (err) {
        console.warn(`  ⚠️ Detail fetch failed for ${title}: ${err?.message}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const city = listing.city || 'Zurich';
    const canton = inferSwissTargetCanton(city) || 'ZH';
    const description = detailInfo.description
      || listing.descriptionTeaser
      || `${title} — Siemens Healthineers, ${city}`;
    const publicUrl = detailInfo.url
      || `${DETAIL_BASE}/${encodeURIComponent(listing.jobSeqNo)}/${slugifyTitle(title)}`;

    const sourceLang = detectLang(description || title, 'en');
    const jobSlug = slugify(`${title} siemens-healthineers ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const empType = listing.type?.toLowerCase().includes('part') ? 'PART_TIME' : 'FULL_TIME';

    const job = {
      // ── Required fields ──
      id: `siemens-healthineers-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SIEMENS_HEALTHINEERS_COMPANY_NAME,
      companyKey: SIEMENS_HEALTHINEERS_KEY,
      companyDomain: SIEMENS_HEALTHINEERS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: city,
      canton,
      url: publicUrl,
      source: 'Siemens Healthineers Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: empType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: empType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Medizintechnik / Medical Devices',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: listing.applyUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Siemens Healthineers Swiss jobs discovered: ${jobs.length}`);
  return jobs;
}

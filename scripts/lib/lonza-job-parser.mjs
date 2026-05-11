#!/usr/bin/env node
/**
 * Lonza job parser — Workday API fetcher and job builder.
 *
 * Extracted from update-lonza-jobs.mjs for use with the standard
 * crawler template. All fetch/parse/build logic lives here;
 * the crawler script only wires it into the template pipeline.
 *
 * Source: https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const LONZA_API_BASE = 'https://lonza.wd3.myworkdayjobs.com/wday/cxs/lonza/Lonza_Careers';
const LONZA_PUBLIC_BASE = 'https://lonza.wd3.myworkdayjobs.com/en/Lonza_Careers';
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

export const LONZA_KEY = 'lonza';
export const LONZA_COMPANY_NAME = 'Lonza';
export const LONZA_COMPANY_DOMAIN = 'lonza.com';
export const LONZA_HOST = 'lonza.wd3.myworkdayjobs.com';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return s.slice(0, 200);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isLonzaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === LONZA_KEY ||
    key.startsWith('lonza') ||
    company.includes('lonza') ||
    url.includes('lonza.wd3.myworkdayjobs.com') ||
    url.includes('lonza.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === LONZA_HOST || host.endsWith('.lonza.com') || host.endsWith('.myworkdayjobs.com');
  } catch {
    return false;
  }
}

/* ── Workday API ───────────────────────────────────────────── */

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'en,de-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        ...options.headers,
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function listSwissJobs() {
  const allPostings = [];
  let offset = 0;
  const limit = 20;

  while (true) {
    const body = JSON.stringify({
      appliedFacets: { locationCountry: SWISS_LOCATION_IDS },
      limit,
      offset,
      searchText: '',
    });

    const data = await fetchJson(`${LONZA_API_BASE}/jobs`, {
      method: 'POST',
      body,
    });

    if (!data || !Array.isArray(data.jobPostings)) {
      if (offset === 0) console.warn('⚠️ Failed to fetch Workday listings.');
      break;
    }

    allPostings.push(...data.jobPostings);

    if (allPostings.length >= (data.total || 0) || data.jobPostings.length < limit) {
      break;
    }
    offset += limit;

    if (data.jobPostings.length === limit) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return allPostings;
}

async function fetchJobDetail(externalPath) {
  return fetchJson(`${LONZA_API_BASE}${externalPath}`);
}

/* ── Location & canton ─────────────────────────────────────── */

function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  // Workday sometimes returns just the country code (e.g. "CH", "UK") — not useful as a city
  if (/^[A-Z]{2}$/.test(cleaned)) return '';
  const parts = cleaned.split(/\s*-\s*/);
  return parts.length > 0 ? parts[0].trim() : cleaned;
}

function inferCanton(location = '') {
  const canton = inferAnyCanton(location);
  if (canton) return canton;
  const loc = normalize(location);
  if (loc.includes('visp') || loc.includes('viège')) return 'VS';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('stein')) return 'AG';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('zürich') || loc.includes('zurich')) return 'ZH';
  if (loc.includes('genev') || loc.includes('genf')) return 'GE';
  return '';
}

/* ── Job classification ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/pharma|drug|formul|gmp|clinical|regulatory\s*affair/i.test(t)) return 'pharma';
  if (/biotech|biolog|cell\s*therap|gene\s*therap|capsid/i.test(t)) return 'biotech';
  if (/chem|laborat|lab\b|analyt|spectro|chromato/i.test(t)) return 'chemistry';
  if (/manufactur|production|batch|process\s*engineer|process\s*techni/i.test(t)) return 'manufacturing';
  if (/quality|qa|qc|valid|qualif/i.test(t)) return 'quality';
  if (/engineer|developer|software|architect|devops|cloud|data|cyber|network|infrastructure|automat/i.test(t)) return 'technology';
  if (/scientist|research|r&d|innovation/i.test(t)) return 'research';
  if (/supply\s*chain|logist|warehous|procurement|purchas/i.test(t)) return 'logistics';
  if (/safety|ehs|environment|health\s*&?\s*safety/i.test(t)) return 'ehs';
  if (/sales|commercial|pre.?sales|account\s*exec|business\s*develop/i.test(t)) return 'sales';
  if (/project|programme|program|scrum|agile/i.test(t)) return 'project-management';
  if (/legal|counsel|lawyer|compliance|regulator/i.test(t)) return 'legal';
  if (/account|financ|controller|audit/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent/i.test(t)) return 'hr';
  if (/support|helpdesk|service\s*desk/i.test(t)) return 'support';
  if (/manag|director|head|lead|chief|vp\b/i.test(t)) return 'management';
  if (/mainten|technic|mechani|electri/i.test(t)) return 'maintenance';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagist|apprenti|graduate|trainee/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal|chief|vp\b/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(timeType = '') {
  const t = normalize(timeType);
  if (t.includes('full')) return 'FULL_TIME';
  if (t.includes('part')) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Main fetch function ───────────────────────────────────── */

/**
 * Fetch all Lonza Swiss jobs from the Workday API.
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllLonzaJobs() {
  console.log(`🔍 Fetching Lonza jobs from Workday API`);
  console.log(`   API: ${LONZA_API_BASE}/jobs`);
  console.log(`   Filter: Switzerland (all Swiss locations)\n`);

  const listings = await listSwissJobs();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned from Workday API.');
    return [];
  }

  console.log(`  📋 Swiss job listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const externalPath = listing.externalPath;
    if (!externalPath) continue;

    console.log(`  📄 Fetching detail: ${listing.title}`);
    const detail = await fetchJobDetail(externalPath);

    const info = detail?.jobPostingInfo || {};
    const title = normalizeSpace(info.title || listing.title || '');
    if (!title || title.length < 3) {
      console.log(`  ⏭️  Skipped — empty title`);
      continue;
    }

    let locationRaw = info.location || listing.locationsText || '';
    let city = parseWorkdayLocation(locationRaw);

    if (!city && detail?.jobPostingInfo?.additionalLocations) {
      for (const addLoc of detail.jobPostingInfo.additionalLocations) {
        const desc = addLoc?.descriptor || '';
        if (desc.toLowerCase().includes('switzerland') || desc.toLowerCase().includes('visp') || desc.toLowerCase().includes('basel') || desc.toLowerCase().includes('stein')) {
          city = parseWorkdayLocation(desc);
          break;
        }
      }
    }
    if (!city) city = 'Visp';

    // Skip foreign locations that slipped through Workday's country filter
    if (isLocationExplicitlyForeign(city)) {
      console.log(`  ⏭️  Skipped foreign location: ${city} — ${title}`);
      continue;
    }

    const canton = inferCanton(city);
    const descriptionHtml = info.jobDescription || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${LONZA_PUBLIC_BASE}${externalPath}`;

    // Build the source-locale description (EN — Lonza posts primarily in English)
    const descEn = descriptionText
      ? `${descriptionText}\n\nLonza is a global leader in pharma and biotech manufacturing. The company operates major production facilities in Visp (Valais), Basel, and Stein (Aargau), Switzerland.`.trim()
      : `${title} position at Lonza in ${city}, Switzerland.\n\nLonza is a global leader in pharma and biotech manufacturing. The company operates major production facilities in Visp (Valais), Basel, and Stein (Aargau), Switzerland.`.trim();

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(title, 'lonza-ch');
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(info.timeType || '');
    const jobReqId = info.jobReqId || (listing.bulletFields || [])[0] || '';

    // ParsedJob contract: only set source-locale fields.
    // Other locales are filled by mergePreserveLocaleData (preserves previous runs)
    // and translate-pending pipeline (AI translation for missing locales).
    const job = {
      id: `lonza-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LONZA_COMPANY_NAME,
      companyKey: LONZA_KEY,
      companyDomain: LONZA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descEn,
      descriptionByLocale: { [sourceLang]: descEn },
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      location: city,
      canton,
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Farmaceutica / Biotecnologia',
      currency: 'CHF',
      featured: false,
      postedDate: info.startDate || new Date().toISOString().split('T')[0],
      url: publicUrl,
      applyUrl: publicUrl,
      source: 'Lonza Dedicated Parser (Workday)',
      sourceLang,
      crawledAt: new Date().toISOString(),
    };

    if (jobReqId) job.jobReqId = jobReqId;

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total unique Lonza jobs discovered: ${jobs.length}`);
  return jobs;
}

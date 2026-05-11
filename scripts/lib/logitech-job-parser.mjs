#!/usr/bin/env node
/**
 * Logitech job parser — Fetcher and job builder.
 *
 * Source: https://logitech.wd5.myworkdayjobs.com/Logitech
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLogitechJobs()  — Fetch and parse all jobs
 *   - isLogitechJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LOGITECH_KEY = 'logitech';
export const LOGITECH_COMPANY_NAME = 'Logitech';
export const LOGITECH_COMPANY_DOMAIN = 'logitech.com';

const CAREER_URL = 'https://logitech.wd5.myworkdayjobs.com/Logitech';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Logitech.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLogitechJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LOGITECH_KEY ||
    key.startsWith('logitech') ||
    company.includes('logitech') ||
    url.includes('logitech.com') ||
    url.includes('logitech.wd5.myworkdayjobs.com')
  );
}

/**
 * Validate that a URL belongs to Logitech's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'logitech.com' ||
      host.endsWith('.logitech.com') ||
      host === 'logitech.wd5.myworkdayjobs.com' ||
      host.endsWith('.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/**
 * Check if a Workday location string indicates a Swiss location.
 * Logitech HQ is in Lausanne (VD); other Swiss sites possible.
 */
function isSwissLocation(locationsText = '') {
  const loc = normalize(locationsText);
  return (
    loc.startsWith('ch ') ||
    loc.startsWith('ch-') ||
    loc.includes('switzerland') ||
    loc.includes('schweiz') ||
    loc.includes('suisse') ||
    loc.includes('svizzera') ||
    loc.includes('lausanne') ||
    loc.includes('zurich') ||
    loc.includes('zürich') ||
    loc.includes('geneva') ||
    loc.includes('genève') ||
    loc.includes('basel') ||
    loc.includes('bern') ||
    loc.includes('lugano')
  );
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

/* ── Workday fetcher ──────────────────────────────────────────
 * The career URL must point to a Workday CXS site, e.g.:
 *   https://{tenant}.wd3.myworkdayjobs.com/{site}
 * Switzerland location filter ID varies per tenant — inspect the network
 * tab on the live site to find the correct facet value.
 */
const _WORKDAY_URL = new URL(CAREER_URL);
const WORKDAY_TENANT_HOST = _WORKDAY_URL.hostname;
const WORKDAY_SITE_PATH = (_WORKDAY_URL.pathname.replace(/^\/+|\/+$/g, '').split('/').pop()) || 'External';
const WORKDAY_LOCATION_FILTERS = []; // TODO: e.g. ['187134fccb084a0ea9b4b95f23890dbe'] for CH on most tenants

const DETAIL_RATE_LIMIT_MS = 400;
const DETAIL_TIMEOUT_MS = 15_000;

/**
 * Fetch a Workday job's detail JSON (jobPostingInfo.jobDescription is the
 * HTML body) and return the description as bullet-preserving plain text.
 * Returns '' on any failure so we can fall back to the structured stub.
 */
async function fetchWorkdayJobDetailDescription(apiBase, externalPath) {
  if (!apiBase || !externalPath) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT_MS);
  try {
    const url = `${apiBase.replace(/\/+$/, '')}${externalPath}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'FrontaliereTicino-JobCrawler/2.0 (+https://frontaliereticino.ch)',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const json = await res.json();
    const html = String(json?.jobPostingInfo?.jobDescription || '').trim();
    if (!html) return '';
    const text = stripHtml(html);
    return text
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJobListings() {
  const apiBase = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(apiBase, {
      locationFilters: WORKDAY_LOCATION_FILTERS,
      maxPages: 20,
    })) {
      const id = extractWorkdayJobIdentity(posting, { apiBase, company: LOGITECH_COMPANY_NAME });
      const locationText = id.location || posting.locationsText || '';
      // Client-side Swiss filter: Workday tenant exposes global jobs; we only ship CH listings.
      if (!isSwissLocation(locationText)) continue;
      out.push({
        title: id.title,
        location: locationText,
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out;
}

/**
 * Parse a Workday location string like "CH - Lausanne" → "Lausanne".
 */
function parseWorkdayLocation(locText = '') {
  const cleaned = String(locText || '').trim();
  if (/\d+\s+location/i.test(cleaned)) return '';
  const match = cleaned.match(/-\s*(.+)$/);
  return match ? match[1].trim() : cleaned;
}

/**
 * Fetch all Logitech jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLogitechJobs() {
  console.log(`🔍 Fetching Logitech jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.location || '';
    const location = parseWorkdayLocation(rawLocation) || 'Lausanne';
    const canton = inferSwissTargetCanton(location) || 'VD';
    const publicUrl = listing.url || CAREER_URL;

    // Always prefer the real description from the Workday detail endpoint
    // (jobPostingInfo.jobDescription). The listing API only carries title +
    // location + posted date, not the body.
    const apiBase = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
    const detailDescription = await fetchWorkdayJobDetailDescription(apiBase, listing.externalPath);
    if (listing.externalPath) {
      await new Promise((r) => setTimeout(r, DETAIL_RATE_LIMIT_MS));
    }

    // TEMPORARY fallback: only used when the Workday detail endpoint refuses
    // the request (anti-bot or 4xx). Long-term we expect the detail fetch to
    // succeed in >99% of cases — the stub is here so a single failure doesn't
    // ship an empty description.
    const fallbackDescription = [
      `${title} — Logitech, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, ${canton} canton` : ''}, Switzerland`,
      '• Employer: Logitech — global designer and manufacturer of consumer electronics',
      `• Schedule: ${listing.timeType || 'see job posting'}`,
      '• Apply on: Logitech Workday careers portal',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} logitech ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `logitech-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LOGITECH_COMPANY_NAME,
      companyKey: LOGITECH_KEY,
      companyDomain: LOGITECH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Logitech Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Tecnologia / Hardware Consumer',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Logitech jobs discovered: ${jobs.length}`);
  return jobs;
}

#!/usr/bin/env node
/**
 * Union Bancaire Privée job parser — Fetcher and job builder.
 *
 * Source: https://www.ubp.com/en/careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllUbpJobs()  — Fetch and parse all jobs
 *   - isUbpJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const UBP_KEY = 'ubp';
export const UBP_COMPANY_NAME = 'Union Bancaire Privée';
export const UBP_COMPANY_DOMAIN = 'ubp.com';

const CAREER_URL = 'https://www.ubp.com/en/careers';
const BASE_URL = 'https://www.ubp.com';
const HQ = getCompanyDefaults('ubp');

/**
 * UBP uses Oracle Cloud HCM. Their careers page links to an external Oracle
 * HCM portal. We query the Oracle HCM REST API directly (same pattern as
 * the EFG crawler) to discover individual job requisitions with proper URLs.
 *
 * Oracle HCM REST API base:
 *   .eu domain (linked from ubp.com): iaadtu.fa.ocs.oraclecloud.eu — DNS dead
 *   .com domain (fallback):           iaadtu.fa.ocs.oraclecloud.com — may 503
 *
 * When the Oracle portal is unreachable, the crawler returns [] gracefully.
 */
const ORACLE_BASES = [
  'https://iaadtu.fa.ocs.oraclecloud.com',
  'https://iaadtu.fa.ocs.oraclecloud.eu',
];
const ORACLE_SITE = 'CX_1';
const ORACLE_ITEMS_PER_PAGE = 25;
const ORACLE_MAX_PAGES = 10;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Union Bancaire Privée.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isUbpJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === UBP_KEY ||
    key.startsWith('ubp') ||
    company.includes('union bancaire privée') ||
    url.includes('ubp.com')
  );
}

/**
 * Validate that a URL belongs to Union Bancaire Privée's domain.
 * Includes Oracle HCM domains since UBP job URLs point there.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ubp.com' ||
      host.endsWith('.ubp.com') ||
      (host.startsWith('iaadtu.') && host.includes('oraclecloud.'))
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

/* ── Oracle HCM REST API helpers ──────────────────────────── */

/**
 * Fetch JSON from a URL with timeout and error handling.
 */
async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`   ⚠️ HTTP ${res.status} from ${url}`);
      return null;
    }
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    console.warn(`   ⚠️ fetchJson failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Build the public detail URL for a given Oracle HCM requisition.
 */
function buildOracleDetailUrl(oracleBase, requisitionId) {
  return `${oracleBase}/hcmUI/CandidateExperience/en/sites/${ORACLE_SITE}/job/${requisitionId}`;
}

/**
 * Fetch full requisition detail payload from Oracle HCM.
 * Contains ExternalDescriptionStr with the full HTML description.
 */
async function fetchRequisitionDetails(oracleBase, requisitionId) {
  const id = String(requisitionId || '').trim();
  if (!id) return null;
  const url = `${oracleBase}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails/${encodeURIComponent(id)}?onlyData=true`;
  return await fetchJson(url);
}

/**
 * Query the Oracle HCM REST API for UBP job requisitions.
 * Tries each Oracle base URL in order until one works.
 * Returns { oracleBase, requisitions } or null if all fail.
 */
async function fetchOracleRequisitions() {
  for (const oracleBase of ORACLE_BASES) {
    console.log(`   Trying Oracle HCM API at ${oracleBase}...`);
    const allRequisitions = [];
    let offset = 0;
    let totalCount = null;
    let apiReachable = false;

    for (let page = 1; page <= ORACLE_MAX_PAGES; page++) {
      const apiUrl = `${oracleBase}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${ORACLE_SITE},facetsList=LOCATIONS,limit=${ORACLE_ITEMS_PER_PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`;

      const data = await fetchJson(apiUrl);
      if (!data || !data.items || data.items.length === 0) {
        if (page === 1) {
          console.warn(`   ⚠️ Oracle HCM API at ${oracleBase} returned no data.`);
        }
        break;
      }

      apiReachable = true;
      const searchItem = data.items[0];
      if (totalCount === null) {
        totalCount = searchItem.TotalJobsCount || 0;
        console.log(`   📊 Total jobs reported by Oracle API: ${totalCount}`);
      }

      const requisitions = searchItem.requisitionList || [];
      if (requisitions.length === 0) break;

      for (const req of requisitions) {
        allRequisitions.push(req);
      }
      console.log(`   📄 Page ${page}: ${requisitions.length} requisitions (offset=${offset})`);

      offset += requisitions.length;
      if (offset >= totalCount) break;

      await new Promise((r) => setTimeout(r, 300));
    }

    if (apiReachable && allRequisitions.length > 0) {
      console.log(`   ✅ ${allRequisitions.length} requisitions from ${oracleBase}`);
      return { oracleBase, requisitions: allRequisitions };
    }

    if (apiReachable && allRequisitions.length === 0) {
      console.log(`   Oracle HCM API reachable but returned 0 requisitions.`);
      return { oracleBase, requisitions: [] };
    }
  }

  return null;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Union Bancaire Privée jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Query Oracle HCM REST API directly (same pattern as EFG crawler)
 *  2. For each requisition, build a proper detail URL and fetch description
 *  3. If Oracle HCM is unreachable, return [] gracefully
 *
 * The old approach of scraping ubp.com/en/careers HTML was producing
 * false-positive jobs from navigation links ("Our job offers") because the
 * careers page contains no actual job listings — only a link to the
 * external Oracle HCM portal.
 */
export async function fetchAllUbpJobs() {
  console.log(`🔍 Fetching Union Bancaire Privée jobs`);
  console.log(`   Oracle HCM site: ${ORACLE_SITE}`);
  console.log(`   Careers page: ${CAREER_URL}\n`);

  const result = await fetchOracleRequisitions();
  if (!result || result.requisitions.length === 0) {
    console.warn('⚠️ No UBP job listings found — Oracle HCM portal may be unreachable or have no open positions.');
    return [];
  }

  const { oracleBase, requisitions } = result;
  console.log(`\n📋 Fetching details for ${requisitions.length} requisitions...`);

  const jobs = [];
  for (const req of requisitions) {
    const reqId = String(req.Id || '');
    const title = normalizeSpace(req.Title || '');
    if (!title || title.length < 3 || !reqId) continue;

    const publicUrl = buildOracleDetailUrl(oracleBase, reqId);

    // Extract location from Oracle HCM data — infer actual canton, don't default
    // to HQ canton for foreign cities (e.g. London, Geneva)
    const primaryLoc = req.PrimaryLocation || '';
    const rawLocation = normalizeSpace(primaryLoc) || HQ?.city || 'Lugano';
    const isForeignLoc = isLocationExplicitlyForeign(rawLocation);
    const canton = inferAnyCanton(rawLocation) || (isForeignLoc ? '' : (HQ?.canton || ''));

    // Fetch full description from detail API
    let descriptionText = '';
    const detailPayload = await fetchRequisitionDetails(oracleBase, reqId);
    if (detailPayload?.ExternalDescriptionStr) {
      descriptionText = stripHtml(detailPayload.ExternalDescriptionStr);
    }
    if (!descriptionText) {
      descriptionText = stripHtml(req.ShortDescriptionStr || '');
    }

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ubp ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = req.PostedDate
      ? String(req.PostedDate).split('T')[0]
      : (detailPayload?.ExternalPostedStartDate || '').split('T')[0]
        || new Date().toISOString().split('T')[0];

    const desc = descriptionText || `${title} — Position at Union Bancaire Privée (UBP) in ${rawLocation}. UBP is one of Switzerland's leading private banks, with offices in Lugano, Geneva, and Zurich, specializing in wealth management and asset management.`;

    const job = {
      id: `ubp-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: UBP_COMPANY_NAME,
      companyKey: UBP_KEY,
      companyDomain: UBP_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location: rawLocation,
      canton,
      url: publicUrl,
      source: 'Union Bancaire Privée Oracle HCM API',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: rawLocation,
      addressRegion: canton || (HQ?.addressRegion || ''),
      addressCountry: isForeignLoc ? '' : 'CH',
      country: isForeignLoc ? '' : 'CH',
      postalCode: canton ? (HQ?.postalCode || '6900') : '',
      category: detectCategory(title),
      contract: detectEmploymentType(req.TimeType || title) === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: detectEmploymentType(req.TimeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Banca / Gestione patrimoniale',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total Union Bancaire Privée jobs discovered: ${jobs.length}`);
  return jobs;
}

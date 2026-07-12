#!/usr/bin/env node
/**
 * Edmond de Rothschild (Suisse) job parser — Oracle Fusion Cloud Recruiting API.
 *
 * Source: https://www.edmond-de-rothschild.com/en/careers
 *
 * Edmond de Rothschild is a family-owned private bank / asset manager
 * headquartered in Geneva (registered office: Rue de Hesse 18, 1204
 * Genève). Its careers page links out to an Oracle Fusion Cloud
 * Recruiting ("Oracle HCM") candidate-experience portal, tenant "evht",
 * site CX_7001. Same pattern as the UBP crawler (Oracle HCM REST API
 * queried directly instead of scraping the SPA shell).
 *
 * Oracle HCM REST API base:
 *   .eu domain (linked from edmond-de-rothschild.com): evht.fa.ocs.oraclecloud.eu — verified live
 *   .com domain (alternate prod host, seen in search results):
 *     fa-evht-saasfaprod1.fa.ocs.oraclecloud.com — DNS/connect dead at discovery time
 *
 * Requisition listings expose only a country-level `PrimaryLocation`
 * ("Switzerland") for every Swiss posting, no city/canton — every CH
 * requisition observed at discovery time shared the same GeographyId
 * (300000000468615). Group-wide, the tenant also posts France (FR),
 * Luxembourg (LU) and Italy (IT) roles from the same feed; we filter to
 * `PrimaryLocationCountry === 'CH'` so only the Swiss subset is ingested.
 *
 * When the Oracle portal is unreachable, the crawler returns [] gracefully.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllEdmondDeRothschildJobs() — Fetch and parse all Swiss jobs
 *   - isEdmondDeRothschildJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()                — Validate URLs belong to this company
 *   - slugify() / stripHtml()          — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const EDMOND_DE_ROTHSCHILD_KEY = 'edmond-de-rothschild';
export const EDMOND_DE_ROTHSCHILD_COMPANY_NAME = 'Edmond de Rothschild';
export const EDMOND_DE_ROTHSCHILD_COMPANY_DOMAIN = 'edmond-de-rothschild.com';

const CAREER_URL = 'https://www.edmond-de-rothschild.com/en/careers';

const ORACLE_BASES = [
  'https://evht.fa.ocs.oraclecloud.eu',
  'https://fa-evht-saasfaprod1.fa.ocs.oraclecloud.com',
];
const ORACLE_SITE = 'CX_7001';
const ORACLE_ITEMS_PER_PAGE = 50;
const ORACLE_MAX_PAGES = 10;

/* ── HQ fallback (Genève, GE) ──────────────────────────────── */

const HQ = getCompanyDefaults(EDMOND_DE_ROTHSCHILD_KEY) || {
  city: 'Genève',
  canton: 'GE',
  postalCode: '1204',
  addressRegion: 'GE',
};
const HQ_STREET_ADDRESS = 'Rue de Hesse 18';

const SECTOR = 'Banca / Gestione patrimoniale';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Edmond de Rothschild.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isEdmondDeRothschildJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === EDMOND_DE_ROTHSCHILD_KEY ||
    key.startsWith('edmond-de-rothschild') ||
    company.includes('edmond de rothschild') ||
    url.includes('edmond-de-rothschild.com') ||
    url.includes('evht.fa.ocs.oraclecloud')
  );
}

/**
 * Validate that a URL belongs to Edmond de Rothschild's domain.
 * Includes the Oracle HCM tenant host since job URLs point there.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'edmond-de-rothschild.com' ||
      host.endsWith('.edmond-de-rothschild.com') ||
      (host.startsWith('evht.') && host.includes('oraclecloud.')) ||
      (host.startsWith('fa-evht-') && host.includes('oraclecloud.'))
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(compliance|legal|counsel|regulat|juridique|droit)/.test(t)) return 'Legale';
  if (/\b(invest|gestion de fortune|wealth|portfolio|trading|salle des march|fx|advisory)/.test(t))
    return 'Finanza';
  if (/\b(controll|account|treasur|tax|fiscal|finance|financ|mis)/.test(t)) return 'Finanza';
  if (/\b(client|onboarding|philanthrop|relations)/.test(t)) return 'Vendite';
  if (/\b(data|develop|software|it\b|informatique|digital|sirh|applicative)/.test(t)) return 'IT';
  if (/\b(hr|human|talent|recruit|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|communicat|kommunikation|brand)/.test(t)) return 'Marketing';
  if (/\b(assistant|support|admin|secret)/.test(t)) return 'Amministrazione';
  if (/\b(s[eé]curit[eé]|security)/.test(t)) return 'IT';
  return 'Finanza';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(stagiaire|stage|intern|apprenti|apprentice|trainee|praktik)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|analyst)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|chef|responsable|manager|dirett)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(stagiaire|stage|intern|apprenti|apprentice)/.test(t)) return 'INTERN';
  // CDD (contrat à durée déterminée) is a fixed-term contract, NOT part-time —
  // matches the established convention in pictet-job-parser.mjs / ubs-job-parser.mjs.
  if (/\b(temporary|tempor|befristet|fixed.?term|cdd)\b/.test(t)) return 'CONTRACTOR';
  return 'FULL_TIME';
}

/* ── Address resolution ───────────────────────────────────── */

/**
 * Resolve the best city / canton / postal code / street address for a raw
 * Oracle HCM `PrimaryLocation` string, falling back to the documented HQ
 * address (Genève, Rue de Hesse 18) only when the resolved canton matches
 * the HQ canton. postalCode AND streetAddress are gated on the SAME
 * canton check — never fall back to HQ street/postal for a job whose
 * resolved canton differs from HQ (see AGENTS.md #6 sibling-pattern note:
 * an earlier crawler let streetAddress fall back unconditionally while
 * postalCode stayed canton-gated, producing internally-inconsistent
 * addresses; both fields must move together here).
 */
function resolveAddress(rawLocationText = '') {
  const cleaned = normalizeSpace(rawLocationText);
  const isForeignLoc = isLocationExplicitlyForeign(cleaned);
  const explicitCanton = !isForeignLoc ? inferAnyCanton(cleaned) : '';
  const canton = explicitCanton || (isForeignLoc ? '' : HQ.canton);
  const isHqCity = !cleaned || /gen[eè]ve|geneva/i.test(cleaned);
  const city = (cleaned && !isHqCity) ? cleaned : HQ.city;

  return {
    city,
    canton,
    postalCode: isHqCity ? (HQ.postalCode || '') : '',
    streetAddress: isHqCity ? HQ_STREET_ADDRESS : '',
  };
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
    if (!res.ok) {
      console.warn(`   ⚠️ HTTP ${res.status} from ${url}`);
      return null;
    }
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    console.warn(`   ⚠️ fetchJson failed for ${url}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the public detail URL for a given Oracle HCM requisition.
 */
function buildOracleDetailUrl(oracleBase, requisitionId) {
  // locale-segment-ok: Oracle HCM candidate portal path, fixed regardless of our site locale
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
 * Query the Oracle HCM REST API for Edmond de Rothschild job requisitions.
 * Tries each Oracle base URL in order until one works. `facetsList=LOCATIONS`
 * is required for the response to include `requisitionList` at all — without
 * it Oracle returns only facet summaries.
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
        } else {
          console.warn(`   ⚠️ Oracle HCM API at ${oracleBase} returned no data on page ${page} (offset=${offset}) — treating as end of pagination.`);
        }
        break;
      }

      apiReachable = true;
      const searchItem = data.items[0];
      if (totalCount === null) {
        totalCount = searchItem.TotalJobsCount || 0;
        console.log(`   📊 Total jobs reported by Oracle API: ${totalCount}`);
      }

      const requisitions = assertJsonListShape(searchItem, { key: 'requisitionList', source: EDMOND_DE_ROTHSCHILD_KEY });
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
 * Fetch all Edmond de Rothschild jobs (Switzerland-side only).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Strategy:
 *  1. Query Oracle HCM REST API directly (same pattern as UBP crawler)
 *  2. Filter to PrimaryLocationCountry === 'CH'
 *  3. For each requisition, build a proper detail URL and fetch description
 *  4. If Oracle HCM is unreachable, return [] gracefully
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllEdmondDeRothschildJobs() {
  console.log(`🔍 Fetching ${EDMOND_DE_ROTHSCHILD_COMPANY_NAME} jobs`);
  console.log(`   Oracle HCM site: ${ORACLE_SITE}`);
  console.log(`   Careers page: ${CAREER_URL}\n`);

  const result = await fetchOracleRequisitions();
  if (!result || result.requisitions.length === 0) {
    console.warn('⚠️ No Edmond de Rothschild job listings found — Oracle HCM portal may be unreachable or have no open positions.');
    return [];
  }

  const { oracleBase, requisitions } = result;
  const swissRequisitions = requisitions.filter((req) => normalize(req.PrimaryLocationCountry || '') === 'ch');
  console.log(`\n📋 ${swissRequisitions.length} Swiss requisitions (of ${requisitions.length} total) — fetching details...`);

  const jobs = [];
  for (const req of swissRequisitions) {
    const reqId = String(req.Id || '');
    const title = normalizeSpace(req.Title || '');
    if (!title || title.length < 3 || !reqId) continue;

    const publicUrl = buildOracleDetailUrl(oracleBase, reqId);

    const rawLocation = normalizeSpace(req.PrimaryLocation || '') || HQ.city;
    const { city, canton, postalCode, streetAddress } = resolveAddress(rawLocation);
    const location = city;

    // Fetch full description from detail API
    let descriptionText = '';
    const detailPayload = await fetchRequisitionDetails(oracleBase, reqId);
    if (detailPayload?.ExternalDescriptionStr) {
      descriptionText = stripHtml(detailPayload.ExternalDescriptionStr);
    }
    if (!descriptionText) {
      descriptionText = stripHtml(req.ShortDescriptionStr || '');
    }

    const fallbackDescription = [
      `${title} — ${EDMOND_DE_ROTHSCHILD_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: Edmond de Rothschild — independent family-owned investment house specializing in Private Banking and Asset Management, with Corporate Finance, Private Equity and Fund Administration activities.',
      '• Swiss footprint: Geneva head office (Rue de Hesse 18) covering private banking, compliance, IT and support functions.',
      '• Apply: Edmond de Rothschild Oracle HCM careers portal.',
    ].join('\n');
    const desc = descriptionText.length >= 100 ? descriptionText : fallbackDescription;

    const sourceLang = detectLang(desc || title, 'fr');
    const jobSlug = slugify(`${title} edmond de rothschild ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = req.PostedDate
      ? String(req.PostedDate).split('T')[0]
      : (detailPayload?.ExternalPostedStartDate || '').split('T')[0]
        || new Date().toISOString().split('T')[0];

    const employmentType = detectEmploymentType(title);

    const job = {
      // ── Required fields ──
      id: `${EDMOND_DE_ROTHSCHILD_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: EDMOND_DE_ROTHSCHILD_COMPANY_NAME,
      companyKey: EDMOND_DE_ROTHSCHILD_KEY,
      companyDomain: EDMOND_DE_ROTHSCHILD_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: 'Edmond de Rothschild Dedicated Parser (Oracle HCM)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: canton || HQ.addressRegion || '',
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: reqId,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total ${EDMOND_DE_ROTHSCHILD_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

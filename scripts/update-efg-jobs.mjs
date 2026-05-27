#!/usr/bin/env node
/**
 * Dedicated EFG International AG crawler runner.
 * Runs only EFG jobs from their Oracle HCM Cloud careers portal and
 * enforces full locale coverage for SEO-critical fields.
 *
 * The EFG careers portal is powered by Oracle HCM Cloud (Fusion Applications)
 * at fa-eqai-saasfaprod1.fa.ocs.oraclecloud.com.
 *
 * Discovery flow:
 *  1. Query Oracle HCM REST API to list all Swiss job requisitions (paginated)
 *  2. For each job, fetch the detail HTML page to extract the full description
 *     from the <meta property="og:description"> tag
 *  3. Write discovered detail URLs as seed URLs in the adapter JSON
 *  4. Invoke the shared crawler core (scripts/lib/shared-jobs-crawler.mjs) with those seeds
 *  5. Post-process: fix company name, location, canton, clean descriptions
 *  6. Validate locale coverage across IT/EN/DE/FR
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage } from './lib/dedicated-crawler-common.mjs';
import { parseEfgOracleDescription } from './lib/efg-job-parser.mjs';
import { detectLanguage } from './lib/detect-language.mjs';
import { isTargetCanton } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const EFG_KEY = 'efg-international';

/**
 * Oracle HCM Cloud configuration for EFG International.
 */
const ORACLE_BASE = 'https://fa-eqai-saasfaprod1.fa.ocs.oraclecloud.com';
const SITE_NUMBER = 'CX_1001';
const LOCATION_ID_CH = '300000000425282'; // Switzerland
const ITEMS_PER_PAGE = 25;
const MAX_PAGES = 20; // safety cap (25 * 20 = 500 jobs max)

const EFG_COMPANY_NAME = 'EFG International AG';
const EFG_COMPANY_HOST = 'fa-eqai-saasfaprod1.fa.ocs.oraclecloud.com';
const EFG_OFFICIAL_HOST = 'efginternational.com';

/**
 * Map Oracle HCM Category values to our canonical job categories.
 * Oracle categories are free-text set by EFG HR; our schema uses:
 * tech | finance | health | engineering | admin | hospitality | sales | other
 */
const ORACLE_CATEGORY_MAP = {
  'wealth planning': 'finance',
  'hr': 'admin',
  'global markets': 'finance',
  'finance': 'finance',
  'it, digital & data': 'tech',
  'operations': 'admin',
  'compliance': 'finance',
  'efg pension funds': 'finance',
  'cso': 'admin',
  'legal': 'finance',
};

function mapOracleCategory(oracleCategory) {
  if (!oracleCategory) return 'finance';
  const key = String(oracleCategory).trim().toLowerCase();
  return ORACLE_CATEGORY_MAP[key] || 'finance';
}

function mapOracleRequisitionType(requisitionType) {
  if (!requisitionType) return 'permanent';
  const type = String(requisitionType).trim().toLowerCase();
  if (type.includes('temporary') || type.includes('fixed term')) return 'temporary';
  if (type.includes('internship') || type.includes('stage')) return 'internship';
  return 'permanent';
}

/**
 * Map Swiss cities to their Ticino-relevance and canton codes.
 * EFG has offices in Lugano (TI), Zurich (ZH), Geneva (GE).
 */
const SWISS_CITY_CANTON = {
  lugano: 'TI',
  bellinzona: 'TI',
  locarno: 'TI',
  mendrisio: 'TI',
  chiasso: 'TI',
  zurich: 'ZH',
  zürich: 'ZH',
  bern: 'BE',
  geneve: 'GE',
  geneva: 'GE',
  genf: 'GE',
  basel: 'BS',
  lausanne: 'VD',
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function detectLang(text = '') {
  return detectLanguage(text, 'en');
}

/**
 * Match a job object as belonging to the EFG crawl.
 */
function isEfgJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === EFG_KEY ||
    key === 'bsi-ora-efg' ||
    key.includes('efg-international') ||
    key.includes('efg-bank') ||
    host.includes('fa-eqai-saasfaprod1') ||
    host.includes('efginternational.com') ||
    company.includes('efg international') ||
    company.includes('efg bank')
  );
}

/**
 * Check whether a URL belongs to one of EFG's trusted domains.
 */
function isTrustedEfgDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.includes('fa-eqai-saasfaprod1') ||
      host.includes('oraclecloud.com') ||
      host.includes('efginternational.com')
    );
  } catch {
    return false;
  }
}

function deriveLocalizedSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  return String(job?.slug || '').trim();
}

/**
 * Extract city from Oracle HCM PrimaryLocation field.
 * Format: "Lugano, Switzerland" or "Geneve, GE, Switzerland"
 */
function extractCity(primaryLocation = '') {
  const parts = primaryLocation.split(',').map((s) => s.trim());
  return parts[0] || '';
}

/**
 * Determine canton code from a city name or location string.
 */
function detectCanton(location = '') {
  const loc = normalize(location);
  for (const [city, canton] of Object.entries(SWISS_CITY_CANTON)) {
    if (loc.includes(city)) return canton;
  }
  return '';
}

function isGenericLocation(value = '') {
  const v = normalize(value);
  return !v || v === 'switzerland' || v === 'svizzera' || v === 'suisse' || v === 'schweiz' || v === 'ch';
}

// ──────────────────────────────────────────────────────────────
// Oracle HCM REST API — Job listing discovery
// ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL with timeout, returning text or null on failure.
 */
async function fetchPage(url, timeoutMs = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch JSON from the Oracle HCM REST API.
 */
async function fetchJson(url, timeoutMs = 15000) {
  const text = await fetchPage(url, timeoutMs);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    console.warn(`⚠️ Invalid JSON from ${url}: ${text.slice(0, 200)}`);
    return null;
  }
}

/**
 * Fetch full requisition detail payload from Oracle HCM.
 * This endpoint contains ExternalDescriptionStr (full HTML description),
 * while listing/OG snippets are often truncated.
 */
async function fetchRequisitionDetails(requisitionId) {
  const id = String(requisitionId || '').trim();
  if (!id) return null;
  const url = `${ORACLE_BASE}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails/${encodeURIComponent(id)}?onlyData=true`;
  return await fetchJson(url);
}

/**
 * Fetch ALL EFG job requisitions via the Oracle HCM REST API.
 * Handles pagination: the API returns `TotalJobsCount` and items per page.
 *
 * Returns an array of requisition objects: { Id, Title, PostedDate,
 * PrimaryLocation, ShortDescriptionStr, PrimaryLocationCountry, ... }
 */
async function fetchEfgRequisitions() {
  console.log('🔍 Querying Oracle HCM REST API for EFG jobs...');
  const allRequisitions = [];
  let offset = 0;
  let totalCount = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const apiUrl = `${ORACLE_BASE}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${SITE_NUMBER},facetsList=LOCATIONS,locationId=${LOCATION_ID_CH},limit=${ITEMS_PER_PAGE},offset=${offset}`;

    const data = await fetchJson(apiUrl);
    if (!data || !data.items || data.items.length === 0) {
      console.warn(`⚠️ Page ${page}: empty API response — stopping pagination.`);
      break;
    }

    const searchItem = data.items[0];
    if (totalCount === null) {
      totalCount = searchItem.TotalJobsCount || 0;
      console.log(`  📊 Total jobs reported by API: ${totalCount}`);
    }

    const requisitions = searchItem.requisitionList || [];
    if (requisitions.length === 0) {
      console.log(`  📄 Page ${page}: 0 requisitions — end of listing.`);
      break;
    }

    for (const req of requisitions) {
      allRequisitions.push(req);
    }
    console.log(`  📄 Page ${page}: ${requisitions.length} requisitions (offset=${offset})`);

    // Check if we've fetched all
    offset += requisitions.length;
    if (offset >= totalCount) {
      console.log(`  ✅ All ${totalCount} jobs fetched.`);
      break;
    }

    // Polite delay between API pages
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`✅ Total EFG requisitions discovered: ${allRequisitions.length}`);
  return allRequisitions;
}

/**
 * Build the detail page URL for a given Oracle HCM requisition ID.
 */
function buildDetailUrl(requisitionId) {
  return `${ORACLE_BASE}/hcmUI/CandidateExperience/en/sites/${SITE_NUMBER}/job/${requisitionId}`;
}

/**
 * Extract the OG description from an Oracle HCM detail HTML page.
 * Oracle HCM sets <meta property="og:description" content="..."/> with
 * the full job description (may be truncated at ~1000 chars by Oracle).
 */
function extractOgDescription(html = '') {
  const match = html.match(/property="og:description"\s+content="([^"]+)"/);
  if (!match) return '';
  return match[1]
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Fetch full descriptions and structured metadata for each requisition.
 * Returns { descriptions: Map<reqId, descriptionHTML>, metadata: Map<reqId, { category, requisitionType, postedDate }> }.
 */
async function fetchDetailDescriptions(requisitions) {
  console.log(`\n🔍 Fetching full descriptions from ${requisitions.length} detail pages...`);
  const descriptions = new Map();
  const metadata = new Map();
  let fetched = 0;
  let failed = 0;
  let fromDetailsApi = 0;
  let fromOgMeta = 0;
  let fromShortDescription = 0;

  for (const req of requisitions) {
    let selectedDescription = '';

    // 1) Primary source: Oracle requisition details API (full HTML description)
    const detailPayload = await fetchRequisitionDetails(req.Id);
    const externalDescription = String(detailPayload?.ExternalDescriptionStr || '').trim();
    if (externalDescription.length > 120) {
      selectedDescription = externalDescription;
      fromDetailsApi += 1;
    }

    // Extract structured metadata from the detail API payload
    if (detailPayload) {
      metadata.set(String(req.Id), {
        category: detailPayload.Category || null,
        requisitionType: detailPayload.RequisitionType || null,
        postedDate: detailPayload.ExternalPostedStartDate
          ? String(detailPayload.ExternalPostedStartDate).split('T')[0]
          : null,
        corporateDescription: String(detailPayload.CorporateDescriptionStr || '').trim() || null,
      });
    }

    // 2) Fallback: OG description from public detail page
    if (!selectedDescription) {
      const detailUrl = buildDetailUrl(req.Id);
      const html = await fetchPage(detailUrl);
      if (html) {
        const ogDescription = extractOgDescription(html);
        if (ogDescription.length > 50) {
          selectedDescription = ogDescription;
          fromOgMeta += 1;
        }
      }
    }

    // 3) Last fallback: ShortDescriptionStr from listing API
    if (!selectedDescription) {
      const shortDescription = normalizeSpace(String(req.ShortDescriptionStr || ''));
      if (shortDescription.length > 10) {
        selectedDescription = shortDescription;
        fromShortDescription += 1;
      }
    }

    if (selectedDescription) {
      descriptions.set(String(req.Id), selectedDescription);
      fetched += 1;
    } else {
      failed += 1;
    }

    // Polite delay between detail page fetches
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`  ✅ Descriptions fetched: ${fetched}, failed: ${failed}`);
  console.log(`     sources → detailsApi=${fromDetailsApi}, ogMeta=${fromOgMeta}, shortDescription=${fromShortDescription}`);
  return { descriptions, metadata };
}

// ──────────────────────────────────────────────────────────────
// Adapter seed URL management
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the EFG adapter JSON has the correct seed URLs
 * (detail page URLs discovered from the Oracle HCM REST API).
 */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${EFG_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${EFG_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: EFG_KEY,
      companyName: EFG_COMPANY_NAME,
      companyHost: EFG_COMPANY_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      notes: `Oracle HCM Cloud at ${ORACLE_BASE} — EFG International career portal, site ${SITE_NUMBER}.`,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.companyHost = EFG_COMPANY_HOST;
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = `Oracle HCM Cloud at ${ORACLE_BASE} — EFG International career portal, site ${SITE_NUMBER}.`;
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${EFG_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Direct job injection from Oracle HCM API data
// ──────────────────────────────────────────────────────────────

/**
 * Build job objects directly from Oracle HCM API data and inject into jobs.json.
 * Oracle HCM renders detail pages as JavaScript SPAs, so the base crawler cannot
 * extract job content from HTML. Instead we build structured job entries from the
 * REST API data (title, description, location, date) and the OG meta descriptions.
 *
 * Returns the number of jobs injected/updated.
 */
function injectJobsFromApi(requisitions, descriptions, metadata = new Map()) {
  const jobs = readExistingCrawlerJobs(EFG_KEY, DATA_JOBS);
  if (!Array.isArray(jobs)) return 0;

  // Index existing jobs by URL for quick lookup
  const urlIndex = new Map();
  for (let i = 0; i < jobs.length; i++) {
    const url = String(jobs[i].url || '').toLowerCase();
    if (url) urlIndex.set(url, i);
  }

  let inserted = 0;
  let updated = 0;

  for (const req of requisitions) {
    const url = buildDetailUrl(req.Id);
    const city = extractCity(req.PrimaryLocation || '');
    const canton = detectCanton(req.PrimaryLocation || '');
    // Skip jobs outside target cantons (TI, GR, VS)
    if (canton && !isTargetCanton(canton)) continue;
    const rawDesc = descriptions.get(String(req.Id)) || req.ShortDescriptionStr || '';
    const parsedContent = parseEfgOracleDescription(rawDesc);
    const description = parsedContent.description || cleanEfgDescription(rawDesc);
    const title = String(req.Title || '').trim();
    if (!title) continue;

    // Read structured metadata from Oracle detail API
    const meta = metadata.get(String(req.Id)) || {};
    const category = mapOracleCategory(meta.category);
    const contract = mapOracleRequisitionType(meta.requisitionType);
    const postedDate = meta.postedDate || req.PostedDate || new Date().toISOString().split('T')[0];

    const slug = `${title}-efg-${city}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200);

    const jobEntry = {
      id: `efg-${req.Id}`,
      slug,
      company: EFG_COMPANY_NAME,
      title,
      // Keep location specific; avoid generic country-only fallback that breaks Ticino relevance filters.
      location: city || '',
      canton: canton || '',
      category,
      contract,
      currency: 'CHF',
      description: description || req.ShortDescriptionStr || '',
      requirements: parsedContent.requirements || [],
      featured: false,
      postedDate,
      url,
      source: 'Oracle HCM API',
      sourceLang: detectLang(description || title),
      companyKey: EFG_KEY,
      companyDomain: EFG_OFFICIAL_HOST,
      titleByLocale: { en: title },
      descriptionByLocale: description ? { en: description } : {},
      requirementsByLocale: parsedContent.requirements?.length ? { en: parsedContent.requirements } : {},
      canonicalContent: parsedContent.canonical ? { byLocale: { en: parsedContent.canonical } } : undefined,
      crawledAt: new Date().toISOString(),
      slugByLocale: {},
      addressLocality: city || '',
      addressCountry: 'CH',
    };

    const existingIdx = urlIndex.get(url.toLowerCase());
    if (existingIdx !== undefined) {
      // Merge: keep existing locale data, update core fields
      const existing = jobs[existingIdx];
      existing.title = title;
      existing.description = jobEntry.description || existing.description;
      existing.requirements = Array.isArray(jobEntry.requirements) && jobEntry.requirements.length > 0
        ? jobEntry.requirements
        : existing.requirements;
      // Never overwrite a specific existing location with a generic/empty one.
      if (!isGenericLocation(jobEntry.location)) {
        existing.location = jobEntry.location;
      } else if (!normalizeSpace(existing.location || '') && city) {
        existing.location = city;
      }
      existing.canton = jobEntry.canton || existing.canton;
      existing.company = EFG_COMPANY_NAME;
      existing.companyKey = EFG_KEY;
      existing.companyDomain = EFG_OFFICIAL_HOST;
      existing.category = jobEntry.category || existing.category;
      existing.contract = jobEntry.contract || existing.contract;
      existing.postedDate = jobEntry.postedDate || existing.postedDate;
      existing.crawledAt = jobEntry.crawledAt;
      existing.titleByLocale = {
        ...(existing.titleByLocale || {}),
        en: title,
      };
      if (jobEntry.description) {
        existing.descriptionByLocale = {
          ...(existing.descriptionByLocale || {}),
          en: jobEntry.description,
        };
      }
      if (Array.isArray(jobEntry.requirements) && jobEntry.requirements.length > 0) {
        existing.requirementsByLocale = {
          ...(existing.requirementsByLocale || {}),
          en: jobEntry.requirements,
        };
      }
      if (jobEntry.canonicalContent?.byLocale?.en) {
        existing.canonicalContent = {
          ...(existing.canonicalContent || {}),
          byLocale: {
            ...((existing.canonicalContent && existing.canonicalContent.byLocale) || {}),
            en: jobEntry.canonicalContent.byLocale.en,
          },
        };
      }
      updated++;
    } else {
      // Skip creating new entries without a specific city-level location.
      // They would be filtered out later and can pollute diff summaries.
      if (isGenericLocation(jobEntry.location)) continue;
      jobs.push(jobEntry);
      urlIndex.set(url.toLowerCase(), jobs.length - 1);
      inserted++;
    }
  }

  // Write back
  fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
  // Also update public copy
  const publicPath = path.resolve(ROOT, 'public', 'data', 'jobs.json');
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.writeFileSync(publicPath, JSON.stringify(jobs, null, 2) + '\n');

  console.log(`✅ API injection: ${inserted} new, ${updated} updated, ${requisitions.length} total EFG jobs.`);
  return inserted + updated;
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

function runBaseCrawler({ localizeExistingOnly = false } = {}) {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: EFG_KEY,
    localizeOnlyCompanyKeys: EFG_KEY,
    forceLocalizeKeys: EFG_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '400',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '400',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing: fix company name, location, canton for EFG jobs
// ──────────────────────────────────────────────────────────────

const EFG_ROLE_SECTION_RE = /\b(Job Description|Main responsibilities|Key Responsibilities|Responsibilities|Skills and Experience|Qualifications|The Role|Your Role|The Position|What you will do|Your Profile|About the Role)\b/i;

function decodeHtml(text = '') {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function formatEfgHtmlDescription(html = '') {
  let text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<p[^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/gi, '\n## $1\n')
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeHtml(text).replace(/\r/g, '\n');
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  const out = [];
  for (const rawLine of lines) {
    if (!rawLine) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    let line = rawLine;
    if (/^[•*-]\s*/.test(line)) line = line.replace(/^[•*-]\s*/, '- ');
    if (/^#{1,6}\s+/.test(line) && !/^##\s+/.test(line)) {
      line = `## ${line.replace(/^#{1,6}\s+/, '')}`;
    }
    if (!/^##\s+/.test(line) && /^[A-Za-zÀ-ÿ][^:]{2,80}:$/.test(line)) {
      line = `## ${line.slice(0, -1)}`;
    }
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function finalizeEfgDescriptionText(text = '') {
  return String(text || '')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function removeEfgFooter(text = '') {
  let out = String(text || '');
  out = out.replace(/(?:Apply now|Jetzt bewerben|Candidati ora|Postuler maintenant)[\s\S]*/i, '');
  out = out.replace(/^.*EFG is committed to providing an equitable.*$/gim, '');
  out = out.replace(/^.*We strongly believe that the diversity.*$/gim, '');
  out = out.replace(/^.*Our sustainable success is based on our talents.*$/gim, '');
  return out;
}

function hasEfgRoleSections(text = '') {
  return EFG_ROLE_SECTION_RE.test(String(text || ''));
}

function isEfgIntroOnly(text = '') {
  const normalized = normalizeSpace(text);
  if (!normalized) return false;
  return /our company\s+efg international/i.test(normalized) && !hasEfgRoleSections(normalized);
}

/**
 * Clean up EFG job description: remove boilerplate intro and CTA footer.
 */
function cleanEfgDescription(desc = '') {
  const raw = String(desc || '');
  const formatted = /<[^>]+>/.test(raw) ? formatEfgHtmlDescription(raw) : raw;
  let cleaned = String(formatted);

  // Remove EFG standard boilerplate sections, even when they are the first heading.
  cleaned = cleaned.replace(/(?:^|\n)##\s*Our Company[\s\S]*?(?=\n##\s*(?:Job Description|Main responsibilities|Skills and Experience|Our Values|The Role|Your Role|The Position)\b|\s*$)/i, '\n');
  cleaned = cleaned.replace(/(?:^|\n)##\s*Our Purpose and Mission[\s\S]*?(?=\n##\s*(?:Job Description|Main responsibilities|Skills and Experience|Our Values|The Role|Your Role|The Position)\b|\s*$)/i, '\n');
  cleaned = finalizeEfgDescriptionText(removeEfgFooter(cleaned));

  // Safety net: if aggressive cleaning leaves only company intro, keep rich formatted content.
  if (isEfgIntroOnly(cleaned)) {
    const rescued = finalizeEfgDescriptionText(removeEfgFooter(formatted));
    if (hasEfgRoleSections(rescued) && rescued.length > cleaned.length + 250) {
      return rescued;
    }
  }

  return cleaned;
}

/**
 * Restore newline formatting in localized descriptions where the AI
 * localization pipeline stripped all \n characters, flattening
 * `## Heading` and `- Bullet` markers into a single line.
 */
function restoreDescriptionNewlines(text = '') {
  let out = String(text || '');
  if (!out) return out;

  // If text already has newlines proportional to section markers, skip
  const nlCount = (out.match(/\n/g) || []).length;
  const sectionCount = (out.match(/## /g) || []).length;
  if (sectionCount > 0 && nlCount >= sectionCount) return out;

  // Insert \n\n before ## headings (when not at start of string)
  out = out.replace(/([^\n])\s*(## )/g, '$1\n\n$2');

  // Insert \n before "- " bullet points (multi-pass for consecutive bullets)
  for (let i = 0; i < 30; i++) {
    const next = out.replace(/([^\n])\s+(- [A-ZÀ-ÖÙ-Ü])/g, '$1\n$2');
    if (next === out) break;
    out = next;
  }

  // Clean up excessive newlines
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Post-process all EFG jobs in data/jobs.json to fix company name,
 * location, canton, category, contract, and description after base crawler extraction.
 */
function postProcessEfgJobs(requisitions = [], descriptions = new Map(), metadata = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;
  let recoveredFromApi = 0;

  // Build a lookup map from requisition ID to its API data
  const reqMap = new Map();
  for (const req of requisitions) {
    reqMap.set(String(req.Id), req);
  }

  for (const job of jobs) {
    if (!isEfgJob(job)) continue;

    // Fix company name (base crawler may extract boilerplate text)
    if (job.company !== EFG_COMPANY_NAME) {
      job.company = EFG_COMPANY_NAME;
      fixed++;
    }

    // Fix companyKey
    if (job.companyKey !== EFG_KEY) {
      job.companyKey = EFG_KEY;
    }
    if (job.companyDomain !== EFG_OFFICIAL_HOST) {
      job.companyDomain = EFG_OFFICIAL_HOST;
    }

    // Extract requisition ID from URL to match with API data
    const reqIdMatch = String(job.url || '').match(/\/job\/(\d+)/);
    const reqId = reqIdMatch ? reqIdMatch[1] : null;
    const apiData = reqId ? reqMap.get(reqId) : null;
    const apiRawDescription = reqId ? String(descriptions.get(reqId) || '') : '';
    const meta = reqId ? metadata.get(reqId) : null;
    const parsedContent = apiRawDescription ? parseEfgOracleDescription(apiRawDescription) : null;

    // Enrich category and contract from Oracle detail API metadata
    if (meta?.category) {
      const mappedCategory = mapOracleCategory(meta.category);
      if (job.category !== mappedCategory) {
        job.category = mappedCategory;
        fixed++;
      }
    }
    if (meta?.requisitionType) {
      const mappedContract = mapOracleRequisitionType(meta.requisitionType);
      if (job.contract !== mappedContract) {
        job.contract = mappedContract;
        fixed++;
      }
    }
    if (meta?.postedDate && !job.postedDate) {
      job.postedDate = meta.postedDate;
    }

    // Fix location from Oracle HCM API data (more reliable than scraping)
    if (apiData?.PrimaryLocation) {
      const city = extractCity(apiData.PrimaryLocation);
      if (city && job.location !== city) {
        job.location = city;
      }
    }

    // Detect and set canton code
    const canton = detectCanton(job.location || '');
    if (canton) {
      job.canton = canton;
    }

    // Fix posted date from API (ISO format)
    if (apiData?.PostedDate && !job.datePosted) {
      job.datePosted = apiData.PostedDate;
    }

    // Rebuild from dedicated API payload when existing text is thin or boilerplate-only.
    const currentDesc = String(job.description || '');
    const currentDescLen = normalizeSpace(currentDesc).length;
    if (apiRawDescription) {
      const apiClean = parsedContent?.description || cleanEfgDescription(apiRawDescription);
      if (apiClean.length > 120) {
        const shouldReplace =
          isEfgIntroOnly(currentDesc) ||
          currentDescLen < 500 ||
          apiClean.length > currentDescLen + 250;
        if (shouldReplace) {
          job.description = apiClean;
          recoveredFromApi += 1;
          fixed += 1;
        }
      }
    }

    // Final clean pass.
    const cleanedDesc = cleanEfgDescription(job.description || '');
    if (cleanedDesc && cleanedDesc.length > 50) {
      job.description = cleanedDesc;
    }
    if (parsedContent?.requirements?.length) {
      job.requirements = parsedContent.requirements;
      job.requirementsByLocale = {
        ...(job.requirementsByLocale || {}),
        en: parsedContent.requirements,
      };
    }
    if (parsedContent?.canonical) {
      job.canonicalContent = {
        ...(job.canonicalContent || {}),
        byLocale: {
          ...((job.canonicalContent && job.canonicalContent.byLocale) || {}),
          en: parsedContent.canonical,
        },
      };
    }
    job.titleByLocale = {
      ...(job.titleByLocale || {}),
      en: job.title,
    };
    if (job.description) {
      job.descriptionByLocale = {
        ...(job.descriptionByLocale || {}),
        en: job.description,
      };
    }

    // Fix descriptionByLocale: restore newline formatting and handle truncated translations.
    // The AI localization pipeline often strips all \n from markdown descriptions,
    // rendering ## headings and - bullets as raw inline text on the job detail page.
    if (job.descriptionByLocale && typeof job.descriptionByLocale === 'object') {
      const mainDescLen = normalizeSpace(job.description || '').length;
      for (const loc of Object.keys(job.descriptionByLocale)) {
        const locDesc = job.descriptionByLocale[loc];
        if (!locDesc) continue;

        const locDescLen = normalizeSpace(locDesc).length;

        // If localized description is severely truncated (<50% of main),
        // replace with the properly formatted main description.
        if (mainDescLen > 200 && locDescLen < mainDescLen * 0.5) {
          job.descriptionByLocale[loc] = job.description;
          fixed++;
          continue;
        }

        // Restore newline formatting stripped by AI localization.
        const restored = restoreDescriptionNewlines(locDesc);
        if (restored !== locDesc) {
          job.descriptionByLocale[loc] = restored;
          fixed++;
        }
      }
    }

    // Regenerate slug if it contains boilerplate or is too long
    if (job.slug && (job.slug.includes('efg-international-is') || job.slug.includes('private-banking-group') || job.slug.length > 120)) {
      const city = extractCity(apiData?.PrimaryLocation || job.location || '');
      const slugBase = `${job.title}-efg-${city}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 200);
      job.slug = slugBase;
    }

  }

  if (fixed > 0 || recoveredFromApi > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    // Also update public copy
    const publicPath = path.resolve(ROOT, 'public', 'data', 'jobs.json');
    fs.mkdirSync(path.dirname(publicPath), { recursive: true });
    fs.writeFileSync(publicPath, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} EFG jobs (fixed company/location/description).`);
    if (recoveredFromApi > 0) {
      console.log(`🩹 Recovered ${recoveredFromApi} EFG descriptions from Oracle details API.`);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logEfgJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const efgJobs = allJobs.filter(isEfgJob);
  const ticinoJobs = efgJobs.filter((job) => normalize(job?.canton) === 'ti');
  const otherCantons = efgJobs.length - ticinoJobs.length;

  console.log(`\n📊 === EFG International AG Job Stats ===`);
  console.log(`  🏦 Job totali trovati (EFG): ${efgJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  if (otherCantons > 0) {
    console.log(`  📍 Job sedi extra-Ticino: ${otherCantons}`);
    const examples = efgJobs
      .filter((job) => normalize(job?.canton) !== 'ti')
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(efgJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'EFG');
  writeCrawlChangeSummaryToGH(crawlDiff, 'EFG');

  return { total: efgJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateEfgLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_EFG_STRICT',
    label: 'EFG',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isEfgJob,
    detectSourceLang: (text) => detectLang(text),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedEfgDomain,
    untrustedDomainReason: 'untrusted_domain_for_efg_job',
    noJobsMessage: 'Nessun job EFG trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(EFG_KEY, 'EFG');
  console.log('🏦 Running dedicated EFG International AG jobs crawler...');
  console.log(`   Oracle HCM: ${ORACLE_BASE}`);
  console.log(`   Site: ${SITE_NUMBER}, Location: Switzerland (${LOCATION_ID_CH})\n`);

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(EFG_KEY, DATA_JOBS).filter(isEfgJob))

  let injectedCount = 0;
  let descriptions = new Map();
  let detailMetadata = new Map();

  // 1. Query Oracle HCM REST API for all Swiss job requisitions
  const requisitions = await fetchEfgRequisitions();

  if (requisitions.length === 0) {
    console.log('⚠️ No EFG job requisitions discovered from Oracle HCM API.');
    console.log('   The portal may be down. Falling back to existing adapter seed URLs...');
  } else {
    // 2. Fetch full descriptions and structured metadata from detail API
    const detailResult = await fetchDetailDescriptions(requisitions);
    descriptions = detailResult.descriptions;
    detailMetadata = detailResult.metadata;

    // 3. Build detail URLs and update adapter
    const detailUrls = requisitions.map((req) => buildDetailUrl(req.Id));
    console.log(`\n📋 ${detailUrls.length} detail page URLs built from API data.`);
    ensureAdapterSeedUrls(detailUrls);

    // 4. Inject jobs directly from API data into jobs.json
    //    (Oracle HCM pages are JavaScript SPAs — the base crawler cannot
    //     extract content from them, so we build entries from the REST API)
    injectedCount = injectJobsFromApi(requisitions, descriptions, detailMetadata);

    if (injectedCount > 0) {
      console.log(`\n✅ ${injectedCount} EFG jobs injected directly from Oracle HCM API.`);
      console.log('   Running shared localization/merge pipeline on existing EFG records.');
    }
  }

  // 5. Run shared generic pipeline:
  //    - crawl mode when API injection is empty
  //    - localization-only mode when API injection already populated jobs.json
  if (injectedCount === 0) {
    await runBaseCrawler({ localizeExistingOnly: false });
  } else {
    await runBaseCrawler({ localizeExistingOnly: true });
  }

  // 6. Post-process EFG jobs: fix company name, location, canton, category, contract, description
  postProcessEfgJobs(requisitions, descriptions, detailMetadata);

  // 7. Log stats
  const stats = logEfgJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job EFG trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  // 8. Validate locale coverage (IT/EN/DE/FR)
  validateEfgLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isEfgJob) : [];
  writeJobsCrawlerSlice(EFG_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: EFG_KEY,
    label: 'EFG',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ EFG crawler failed: ${err?.message || err}`);
  process.exit(1);
});

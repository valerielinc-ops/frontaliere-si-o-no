#!/usr/bin/env node
/**
 * Dedicated International School of Ticino (IST) crawler runner.
 *
 * IST is part of the Inspired Education Group. Jobs are listed on the
 * group's careers portal at jobs.inspirededu.com.
 *
 * The portal migrated from a server-rendered TalentBrew/iCIMS site to a
 * SuccessFactors RMK / Jobs2Web (Phenom) AJAX-loaded widget (backend
 * 174502.jobs2web.com / career2.successfactors.eu?company=inspireded).
 * The search results are now injected client-side, so the static search
 * HTML no longer contains any `/job/<id>` hrefs. Discovery therefore reads
 * the portal's flat sitemap.xml, which still lists every live
 * `/job/<City-Slug>/<id>/` URL (no API key, no headless browser — $0).
 *
 * The per-job detail pages still expose the same schema.org microdata
 * (itemprop title / streetAddress / datePosted / hiringOrganization +
 * data-careersite-propertyid description), so detail parsing is unchanged.
 *
 * Discovery flow:
 *   1. Fetch https://jobs.inspirededu.com/sitemap.xml
 *   2. Extract every live /job/<slug>/<id>/ URL; the sitemap is the complete
 *      multi-campus source, so discovery must not encode a city allowlist.
 *   3. Fetch each job detail page, parse schema.org microdata
 *   4. Build job objects and merge into data/jobs.json
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
 *
 * The detail page remains authoritative for the Swiss location. Foreign
 * postings from the group's worldwide portal are discarded after parsing;
 * missing or unresolved locations are never assigned a historical default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergePreserveLocaleData,
  detectLang,
  isLocationExplicitlyForeign,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { inferAnyCanton, isTargetSwissLocation } from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { getCantonDisplayName } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { locateTagByAttribute, extractBalancedTagBlock } from './lib/hospital-custom-html-helpers.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const IST_KEY = 'international-school-of-ticino';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(IST_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const IST_COMPANY_NAME = 'International School of Ticino';
const IST_COMPANY_HOST = 'jobs.inspirededu.com';
const IST_SITEMAP_URL = 'https://jobs.inspirededu.com/sitemap.xml';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Stable discovery seed recorded in the adapter config. The sitemap stays
// valid as postings rotate — NOT the per-job `/job/<id>/` URLs, which 404 the
// moment a posting is filled (the prior single-job seed was the original
// source of the recurring 0-job health-check flag).
const IST_DISCOVERY_SEED_URLS = [
  IST_SITEMAP_URL,
];

const UA = process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

const IST_SHARED_PORTAL_COMPANIES = new Set([
  'inspired education',
  'inspired education group',
]);
const IST_DETAIL_TENANT_RE = /\b(?:international\s+school\s+of\s+ticino|scuola\s+internazionale\s+(?:di|del)\s+ticino|école\s+internationale\s+du\s+tessin|internationale\s+schule\s+des\s+tessins)\b/i;
const IST_ROLE_TENANT_SIGNAL_RE = /(?:\b(?:the\s+)?international\s+school\s+of\s+ticino\s+(?:\([^)]*\)\s+)?(?:is\s+(?:seeking|looking\s+for|recruiting|hiring))\b|\bscuola\s+internazionale\s+(?:di|del)\s+ticino\s+(?:cerca|sta\s+cercando)\b|\bécole\s+internationale\s+du\s+tessin\s+(?:recherche|cherche)\b|\binternationale\s+schule\s+des\s+tessins\s+sucht\b)/i;

function hasVerifiedIstRoleTenantSignal(detail = {}) {
  return IST_ROLE_TENANT_SIGNAL_RE.test(normalizeSpace(detail.description));
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return truncateSlugAtWordBoundary(s, 200);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
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

function isIstJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');

  return (
    key === IST_KEY ||
    key.startsWith('international-school-of-ticino') ||
    company === normalize(IST_COMPANY_NAME)
  );
}

// The shared Inspired portal also publishes other schools and central-group
// roles. Keep the broad host match only for retiring legacy rows during merge;
// newly fetched details must pass isIstDetailJob() before they can be emitted.
function isLegacyIstJob(job) {
  return isIstJob(job) || String(job?.url || '').toLowerCase().includes(IST_COMPANY_HOST);
}

export function isIstDetailJob(detail = {}) {
  const detailIdentityValues = [
    detail.hiringOrganization,
    detail.company,
    detail.tenant,
    detail.tenantName,
    detail.facility,
    detail.facilityName,
    detail.school,
    detail.employer,
    detail.schoolName,
    detail.organization,
    detail.site,
    detail.siteName,
  ]
    .map((value) => normalize(value))
    .filter(Boolean);
  const detailCompanies = [detail.hiringOrganization, detail.company]
    .map((value) => normalize(value))
    .filter(Boolean);
  const normalizedSourceUrl = normalize(detail.sourceUrl).replace(/[-_/]+/g, ' ');
  const hasIstTenantMarker = IST_DETAIL_TENANT_RE.test(normalizedSourceUrl);
  const hasVerifiedIstTenant = detailIdentityValues.some((value) => IST_DETAIL_TENANT_RE.test(value));
  const hasOnlySharedPortalCompanies = detailCompanies.length === 0
    || detailCompanies.every((company) => IST_SHARED_PORTAL_COMPANIES.has(company));

  // The shared SuccessFactors page reports "Inspired Education" as the
  // hiringOrganization even for a campus posting. Prefer an explicit,
  // detail-level tenant/company field whenever the page exposes one; a
  // generic "international school" phrase in a title/description or the
  // shared host alone is not an identity signal. The exact tenant slug is
  // retained as the portal's verified fallback for pages whose structured
  // detail payload contains only the shared group organization.
  return hasVerifiedIstTenant
    || (hasOnlySharedPortalCompanies && (hasIstTenantMarker || hasVerifiedIstRoleTenantSignal(detail)));
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === IST_COMPANY_HOST || host.endsWith('.inspirededu.com');
  } catch {
    return false;
  }
}

/* ── HTML fetching ─────────────────────────────────────────── */

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': UA,
      },
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover live IST job-detail URLs from the careers portal sitemap.
 *
 * The portal's search results are AJAX-loaded (SuccessFactors RMK /
 * Jobs2Web), so the static search HTML has no `/job/` hrefs. The flat
 * sitemap.xml lists every live job URL across the group's campuses; the
 * detail fetch then applies the shared Swiss-location guard and re-derives
 * the canton from each page's streetAddress.
 */
async function discoverIstJobUrls() {
  console.log(`🔍 Reading IST job sitemap: ${IST_SITEMAP_URL}`);

  const xml = await fetchHtml(IST_SITEMAP_URL);
  if (!xml) {
    console.warn('⚠️ Could not fetch IST sitemap.xml — keeping existing data.');
    return [];
  }

  const locPattern = /<loc>\s*(https?:\/\/[^<]*\/job\/[^<]+?)\s*<\/loc>/gi;
  const allJobUrls = [];
  let match;
  while ((match = locPattern.exec(xml)) !== null) {
    allJobUrls.push(match[1].trim());
  }
  console.log(`  🗺️  Sitemap lists ${allJobUrls.length} total job URLs`);

  const urls = new Set(allJobUrls);
  console.log(`  📋 Discovered ${urls.size} job URLs for detail-level Swiss filtering`);
  if (urls.size === 0) {
    console.log('  ℹ️ No live job URLs in the portal sitemap.');
  }
  return [...urls];
}

/* ── Job detail parsing ────────────────────────────────────── */

function extractMicrodata(html) {
  const get = (prop) => {
    // Try <meta itemprop="prop" content="...">
    const metaRe = new RegExp(`itemprop="${prop}"\\s+content="([^"]*)"`, 'i');
    const metaMatch = html.match(metaRe);
    if (metaMatch) return metaMatch[1].trim();

    // Try <span itemprop="prop">...</span>
    const spanRe = new RegExp(`itemprop="${prop}"[^>]*>([^<]+)`, 'i');
    const spanMatch = html.match(spanRe);
    if (spanMatch) return spanMatch[1].trim();
    return '';
  };

  const getPropertyId = (propId) => {
    const re = new RegExp(`data-careersite-propertyid="${propId}"[^>]*>([\\s\\S]*?)(?=<\\/span>|<span)`, 'i');
    const m = html.match(re);
    return m ? normalizeSpace(stripHtml(m[1])) : '';
  };

  return {
    title: get('title') || getPropertyId('title'),
    location: get('streetAddress') || getPropertyId('location'),
    datePosted: get('datePosted'),
    hiringOrganization: get('hiringOrganization'),
    company: get('company') || getPropertyId('company') || getPropertyId('employer'),
    tenant: get('tenant') || getPropertyId('tenant') || getPropertyId('tenantName'),
    facility: get('facility') || get('schoolName') || getPropertyId('facility'),
    description: getPropertyId('description'),
  };
}

async function fetchJobDetail(url) {
  console.log(`  📄 Fetching: ${url.split('/').slice(-3, -1).join('/')}`);
  const html = await fetchHtml(url);
  if (!html) return null;

  const data = extractMicrodata(html);

  // Extract the full description from the description block. The block is
  // heavily nested (`<span data-careersite-propertyid="description">` wraps
  // an inner `<span class="jobdescription">` with many nested `<p>`/`<span>`
  // paragraphs), so a naive non-greedy `[\s\S]*?</span>` regex stops at the
  // FIRST inner close tag and truncates to a short generic intro instead of
  // the real job-specific content — use the shared balanced-tag walker.
  const descLoc = locateTagByAttribute(html, 'data-careersite-propertyid="description"', { skipVoidTags: true });
  if (descLoc) {
    const descBlock = extractBalancedTagBlock(descLoc.rest, descLoc.tagName);
    if (descBlock) data.description = stripHtml(descBlock);
  }

  // Historic generic `/job/<city>-<role>/<id>/` URLs can omit the tenant
  // marker while the detail body still contains the official hiring sentence.
  // Promote only that exact school-specific sentence to a tenant signal; a
  // generic mention of an international school is deliberately insufficient.
  if (!data.tenant && !data.tenantName && hasVerifiedIstRoleTenantSignal(data)) {
    data.tenant = IST_COMPANY_NAME;
  }

  // Get canonical URL if available
  const canonicalRe = /rel="canonical"\s+href="([^"]+)"/i;
  const canonicalMatch = html.match(canonicalRe);
  if (canonicalMatch) {
    data.canonicalUrl = canonicalMatch[1];
  }

  // Extract job ID from URL
  const idMatch = url.match(/\/(\d+)\/?$/);
  data.jobId = idMatch ? idMatch[1] : '';

  data.sourceUrl = url;

  return data;
}

/* ── Location & canton mapping ─────────────────────────────── */

function parseLocation(locText = '') {
  // Format: "City, CH" or "City"
  const parts = locText.split(',');
  return parts[0].trim();
}

/**
 * Extract the ISO country code from a streetAddress like "City, CH" or
 * "City, IT". Returns the upper-cased 2-letter code, or '' when absent.
 * The detail page's country code is an additional guard for border or
 * ambiguous city names that the shared location table can recognize.
 */
export function parseCountryCode(locText = '') {
  const parts = String(locText || '').split(',');
  if (parts.length < 2) return '';
  const tail = parts[parts.length - 1].trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(tail)) return '';
  // Inspired's location field also uses the final component for Swiss
  // canton codes (for example, "St. Gallen, SG" and "Fribourg, FR"). A
  // matching canton is Swiss evidence, not a foreign-country code. Resolve
  // only the locality before the suffix so a mismatched code remains foreign
  // (for example, "Zurich, FR").
  const locality = parts.slice(0, -1).join(',').trim();
  return inferAnyCanton(locality) === tail ? 'CH' : tail;
}

/* ── Job building ──────────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/teacher|insegnante|docente|professor|tutor/i.test(t)) return 'education';
  if (/head\s*of|director|principal|coordinator/i.test(t)) return 'management';
  if (/counselor|counsellor|psych|welfare/i.test(t)) return 'student-services';
  if (/admin|secretary|reception|office/i.test(t)) return 'administration';
  if (/nurse|health|medical/i.test(t)) return 'healthcare';
  if (/it\b|tech|system/i.test(t)) return 'technology';
  if (/librarian|library/i.test(t)) return 'education';
  if (/maintenance|facility|caretaker|custodian/i.test(t)) return 'operations';
  if (/expression of interest/i.test(t)) return 'general';
  return 'education';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(junior|assistant|aide|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|trainee|apprenti)/i.test(t)) return 'ENTRY';
  if (/senior|head|director|principal|lead|chief|coordinator/i.test(t)) return 'SENIOR';
  return 'MID';
}

function buildDescription(title, descriptionText, location, canton) {
  const region = getCantonDisplayName(canton, 'en') || 'Switzerland';
  const place = location || region;
  const base = descriptionText || `${title} position at the International School of Ticino in ${place}, Switzerland.`;
  return `${base}\n\nThe International School of Ticino (IST) is part of the Inspired Education Group, one of the world's leading premium school groups. Located in ${place}, IST offers a stimulating international learning environment in ${region}.`.trim();
}

function buildDescriptionIt(title, location, canton) {
  const region = getCantonDisplayName(canton, 'it') || 'Svizzera';
  const place = location || region;
  return `Posizione aperta presso la International School of Ticino a ${place}.\nRuolo: ${title}.\n\nLa International School of Ticino (IST) fa parte di Inspired Education Group, uno dei principali gruppi scolastici premium al mondo. Situata a ${place}, IST offre un ambiente di apprendimento internazionale stimolante in ${region}.`.trim();
}

/* ── Fetch and build all IST jobs ──────────────────────────── */

async function fetchIstJobs() {
  console.log(`🏫 Fetching International School of Ticino jobs`);
  console.log(`   Portal: ${IST_COMPANY_HOST}\n`);

  const jobUrls = await discoverIstJobUrls();
  if (jobUrls.length === 0) {
    console.warn('⚠️ No IST job URLs discovered.');
    return [];
  }

  const jobs = [];
  for (const url of jobUrls) {
    const detail = await fetchJobDetail(url);
    if (!detail || !detail.title) {
      console.log(`  ⏭️  Skipped — no title extracted`);
      continue;
    }

    if (!isIstDetailJob(detail)) {
      console.log(`  ⏭️  Skipped — detail belongs to another Inspired tenant: ${detail.title}`);
      continue;
    }

    const title = normalizeSpace(detail.title);
    const rawLocation = normalizeSpace(detail.location);
    const city = parseLocation(rawLocation);

    // The portal is worldwide. Require a resolved Swiss municipality/canton,
    // exclude explicit foreign locations, and then use the detail page's
    // canton as the per-announcement source of truth.
    const countryCode = parseCountryCode(rawLocation);
    if (countryCode && countryCode !== 'CH') {
      console.log(`  ⏭️  Skipped — ${city}, ${countryCode} is not in Switzerland`);
      continue;
    }

    if (
      !rawLocation ||
      isLocationExplicitlyForeign(rawLocation) ||
      !isTargetSwissLocation(rawLocation, { includeBorderProximity: false })
    ) {
      console.log(`  ⏭️  Skipped — unresolved or non-Swiss location: ${rawLocation || 'missing'}`);
      continue;
    }

    const canton = inferAnyCanton(rawLocation);
    if (!canton || !city) {
      console.log(`  ⏭️  Skipped — canton/city not resolved from: ${rawLocation}`);
      continue;
    }
    const publicUrl = detail.canonicalUrl || url;

    const descEn = buildDescription(title, detail.description, city, canton);
    const descIt = buildDescriptionIt(title, city, canton);

    const slug = slugify(title, 'ist');

    const job = {
      url: publicUrl,
      applyUrl: publicUrl,
      title,
      company: IST_COMPANY_NAME,
      companyKey: IST_KEY,
      location: city,
      canton,
      country: 'CH',
      description: descEn,
      descriptionByLocale: {
        en: descEn,
        it: descIt,
      },
      titleByLocale: {
        en: title,
      },
      slug,
      slugByLocale: {
        en: slug,
        it: slugify(title, 'ist'),
      },
      category: detectCategory(title),
      datePosted: detail.datePosted
        ? new Date(detail.datePosted).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      source: 'ist-inspirededu-crawler',
      sourceLang: detectLang(descEn || title, 'en'),
      employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(title),
      sector: 'Istruzione / Scuola internazionale',
      _targetScope: { canton, location: city },
    };

    if (detail.jobId) job.jobReqId = detail.jobId;

    jobs.push(job);
  }

  console.log(`\n📋 Total unique IST jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge into data/jobs.json ─────────────────────────────── */

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeIstJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(IST_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonIstJobs = allJobs.filter((j) => !isLegacyIstJob(j));
  const existingIstJobs = allJobs.filter(isLegacyIstJob);

  const existingKeys = new Set(
    existingIstJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const discoveredKeys = new Set(
    discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingIstJobs, discoveredJobs).map((job) => ({
    ...job,
    company: IST_COMPANY_NAME,
    companyKey: IST_KEY,
    country: 'CH',
    source: 'ist-inspirededu-crawler',
  }));

  const final = [...nonIstJobs, ...merged];

  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

/* ── Adapter management ────────────────────────────────────── */

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${IST_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = IST_KEY;
  adapter.companyName = IST_COMPANY_NAME;
  adapter.companyHost = IST_COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['sitemap', 'html', 'jsonld'];
  adapter.seedUrls = IST_DISCOVERY_SEED_URLS;
  adapter.notes = 'SuccessFactors RMK / Jobs2Web portal at jobs.inspirededu.com — search is AJAX-loaded, so discovery reads the complete sitemap and filters each detail by isTargetSwissLocation() plus inferAnyCanton(). seedUrls contains the stable sitemap entry point; foreign or unresolved locations are never published.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${IST_KEY} updated with ${IST_DISCOVERY_SEED_URLS.length} stable seed URLs.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: IST_KEY,
    localizeOnlyCompanyKeys: IST_KEY,
    forceLocalizeKeys: IST_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcessIstJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;
  let dropped = 0;
  const nextJobs = [];

  for (const job of jobs) {
    if (!isIstJob(job)) {
      nextJobs.push(job);
      continue;
    }

    const location = parseLocation(normalizeSpace(job.location || job.addressLocality || ''));
    const rawLocation = normalizeSpace([job.location, job.addressLocality].filter(Boolean).join(', '));
    const canton = inferAnyCanton(rawLocation);
    if (
      !location ||
      !canton ||
      isLocationExplicitlyForeign(rawLocation) ||
      !isTargetSwissLocation(rawLocation, { includeBorderProximity: false })
    ) {
      dropped++;
      console.warn(`  ⏭️  Dropped IST row with unresolved or non-Swiss location: ${rawLocation || 'missing'}`);
      continue;
    }

    if (job.company !== IST_COMPANY_NAME) {
      job.company = IST_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== IST_KEY) {
      job.companyKey = IST_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (job.canton !== canton) {
      job.canton = canton;
      fixed++;
    }
    if (job.location !== location) {
      job.location = location;
      fixed++;
    }
    nextJobs.push(job);
  }

  if (fixed > 0 || dropped > 0) {
    writeJsonAtomic(DATA_JOBS, nextJobs);
    writeJsonAtomic(PUBLIC_JOBS, nextJobs);
    console.log(`🔧 Post-processed IST jobs (fixed ${fixed}, dropped ${dropped}).`);
  }
}

/* ── Stats & validation ────────────────────────────────────── */

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const istJobs = allJobs.filter(isIstJob);

  console.log(`\n📊 === International School of Ticino Job Stats ===`);
  const byCanton = new Map();
  for (const job of istJobs) {
    const canton = job.canton || 'UNKNOWN';
    byCanton.set(canton, (byCanton.get(canton) || 0) + 1);
  }
  const cantonSummary = [...byCanton.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([canton, count]) => `${canton}: ${count}`)
    .join(', ') || 'none';
  console.log(`  🏫 Total IST jobs: ${istJobs.length} (${cantonSummary})`);

  if (istJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of istJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(istJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'IST');
  writeCrawlChangeSummaryToGH(crawlDiff, 'IST');
  return { total: istJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_IST_STRICT',
    label: 'International School of Ticino',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isIstJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_inspirededu_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No IST jobs found — the school may not have active openings.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(IST_KEY, 'International School of Ticino');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  International School of Ticino — Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Portal: ${IST_COMPANY_HOST}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(IST_KEY, DATA_JOBS).filter(isIstJob))

  // Phase 1: Discover job URLs
  const discoveredJobs = await fetchIstJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No IST jobs discovered.');
    console.log('   The careers portal may have no current Swiss openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    // Refresh adapter metadata even on the empty path so its stable discovery
    // seeds never drift back to a frozen per-job URL between live openings.
    updateAdapterConfig();
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeIstJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization
  console.log('\n🌐 Running base crawler for AI localization of IST jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessIstJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No IST jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ International School of Ticino crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isIstJob) : [];
  writeJobsCrawlerSlice(IST_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: IST_KEY,
    label: 'International School of Ticino',
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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => exitCrawlerOnError(err, 'International School of Ticino'));
}

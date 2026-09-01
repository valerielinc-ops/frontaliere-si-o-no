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
 *   2. Extract /job/<slug>/<id>/ URLs whose city slug maps to an IST
 *      Swiss canton (TI / GR) — a cheap pre-filter so we only fetch
 *      detail pages that can plausibly be IST positions.
 *   3. Fetch each job detail page, parse schema.org microdata
 *   4. Build job objects and merge into data/jobs.json
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
 *
 * IST commonly has zero live openings; in that case the sitemap simply
 * contains no TI/GR slugs and the crawler legitimately keeps existing data
 * (no error) — see fetchIstJobs / main's empty-result branch.
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
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { getCantonDisplayName, getCompanyDefaults } from './lib/crawler-location-config.mjs';
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
const DEFAULT_CANTON = getCompanyDefaults(IST_KEY)?.canton || 'TI';
const IST_COMPANY_NAME = 'International School of Ticino';
const IST_COMPANY_HOST = 'jobs.inspirededu.com';
const IST_BASE_URL = 'https://jobs.inspirededu.com';
const IST_SITEMAP_URL = 'https://jobs.inspirededu.com/sitemap.xml';
const LOCALES = ['it', 'en', 'de', 'fr'];

// Stable discovery seeds recorded in the adapter config. These are
// location-scoped entry points (sitemap + TalentBrew location search) that
// stay valid as postings rotate — NOT the per-job `/job/<id>/` URLs, which
// 404 the moment a posting is filled (the prior single-job seed was the
// original source of the recurring 0-job health-check flag).
const IST_DISCOVERY_SEED_URLS = [
  IST_SITEMAP_URL,
  'https://jobs.inspirededu.com/search-jobs/results?Location=Lugano&CurrentPage=1',
  'https://jobs.inspirededu.com/search-jobs/results?Location=Chur&CurrentPage=1',
];

// Cantons where IST (and its sister Inspired campuses that share the
// "International School of Ticino" crawler scope) physically operate.
// Used as a cheap sitemap-slug pre-filter; the authoritative canton is
// re-derived from each job detail page's streetAddress.
const IST_TARGET_CANTONS = new Set(['TI', 'GR']);

const UA = process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
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
  const url = String(job?.url || '').toLowerCase();

  return (
    key === IST_KEY ||
    key.startsWith('international-school-of-ticino') ||
    (company.includes('international school') && company.includes('ticino')) ||
    (url.includes('inspirededu.com') && (url.includes('ticino') || url.includes('lugano')))
  );
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

/* ── Discovery ─────────────────────────────────────────────── */

/**
 * Decode the city token from a `/job/<City-Slug>/<id>/` URL and resolve it to
 * a canton. Inspired's sitemap encodes the location as the first segment of
 * the job slug (e.g. `/job/Lugano-German-Teacher/...`, `/job/Chur-Maths/...`).
 * The token may be percent-encoded (`%C3%A9`, `&apos;`) so we decode before
 * extracting the leading word(s).
 */
function inferCantonFromJobUrl(jobUrl = '') {
  let path = jobUrl;
  try {
    path = new URL(jobUrl, IST_BASE_URL).pathname;
  } catch {
    /* fall through with raw value */
  }
  const m = path.match(/\/job\/([^/]+)/i);
  if (!m) return null;

  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep raw slug on malformed encoding */
  }
  slug = slug.replace(/&apos;|&#39;/g, "'").replace(/[-+]/g, ' ');

  // Try the leading 1- and 2-word city candidates (e.g. "St Moritz").
  const words = slug.split(/\s+/).filter(Boolean);
  const candidates = [];
  if (words[0]) candidates.push(words[0]);
  if (words[1]) candidates.push(`${words[0]} ${words[1]}`);
  for (const candidate of candidates) {
    const canton = inferAnyCanton(candidate);
    if (canton) return canton;
  }
  return null;
}

/**
 * Discover live IST job-detail URLs from the careers portal sitemap.
 *
 * The portal's search results are AJAX-loaded (SuccessFactors RMK /
 * Jobs2Web), so the static search HTML has no `/job/` hrefs. The flat
 * sitemap.xml still lists every live job URL, so we read it and keep only
 * URLs whose city slug maps to an IST canton (TI / GR). The detail fetch
 * then re-derives the real canton from each page's streetAddress.
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

  const urls = new Set();
  for (const jobUrl of allJobUrls) {
    const canton = inferCantonFromJobUrl(jobUrl);
    if (canton && IST_TARGET_CANTONS.has(canton)) {
      urls.add(jobUrl);
    }
  }

  console.log(`  📋 Discovered ${urls.size} TI/GR-area job URLs`);
  if (urls.size === 0) {
    console.log('  ℹ️ No Lugano/Ticino/Graubünden roles live right now (IST often has no openings).');
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

function inferCanton(location = '') {
  return inferAnyCanton(location) || 'TI';
}

function parseLocation(locText = '') {
  // Format: "Lugano, CH" or "Lugano"
  const parts = locText.split(',');
  return parts[0].trim() || 'Lugano';
}

/**
 * Extract the ISO country code from a streetAddress like "Lugano, CH" or
 * "Como, IT". Returns the upper-cased 2-letter code, or '' when absent.
 * Inspired's portal lists Italian border cities (e.g. Como) whose city slug
 * maps to a Swiss frontalier canton (TI) in our location table, so we must
 * trust the detail page's country code to reject non-CH (e.g. Como, IT) jobs.
 */
function parseCountryCode(locText = '') {
  const parts = String(locText || '').split(',');
  if (parts.length < 2) return '';
  const tail = parts[parts.length - 1].trim().toUpperCase();
  return /^[A-Z]{2}$/.test(tail) ? tail : '';
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

// City fallbacks per canton. IST's physical campuses are in Lugano (TI) and
// Chur (GR); other cantons use the canton name as the city fallback.
const IST_DEFAULT_CITY_BY_CANTON = {
  TI: 'Lugano',
  GR: 'Chur',
};

function istFallbackCity(canton, locale = 'it') {
  return IST_DEFAULT_CITY_BY_CANTON[canton] || getCantonDisplayName(canton, locale);
}

function buildDescription(title, descriptionText, location, canton = DEFAULT_CANTON) {
  const region = getCantonDisplayName(canton, 'en');
  const defaultCity = istFallbackCity(canton, 'en');
  const base = descriptionText || `${title} position at the International School of Ticino in ${location}, Switzerland.`;
  return `${base}\n\nThe International School of Ticino (IST) is part of the Inspired Education Group, one of the world's leading premium school groups. Located in ${defaultCity}, IST offers a stimulating international learning environment in ${region}.`.trim();
}

function buildDescriptionIt(title, location, canton = DEFAULT_CANTON) {
  const region = getCantonDisplayName(canton, 'it');
  const defaultCity = istFallbackCity(canton, 'it');
  return `Posizione aperta presso la International School of Ticino a ${location}.\nRuolo: ${title}.\n\nLa International School of Ticino (IST) fa parte di Inspired Education Group, uno dei principali gruppi scolastici premium al mondo. Situata a ${defaultCity}, IST offre un ambiente di apprendimento internazionale stimolante in ${region}.`.trim();
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

    const title = normalizeSpace(detail.title);
    const city = parseLocation(detail.location);

    // Authoritative country guard: the sitemap-slug pre-filter can let in
    // Italian border cities (e.g. "Como, IT") whose name maps to a Swiss
    // frontalier canton. Trust the detail page's country code and drop any
    // job that is not explicitly in Switzerland.
    const countryCode = parseCountryCode(detail.location);
    if (countryCode && countryCode !== 'CH') {
      console.log(`  ⏭️  Skipped — ${city}, ${countryCode} is not in Switzerland`);
      continue;
    }

    const canton = inferCanton(city);
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

  const nonIstJobs = allJobs.filter((j) => !isIstJob(j));
  const existingIstJobs = allJobs.filter(isIstJob);

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
  adapter.notes = 'SuccessFactors RMK / Jobs2Web portal at jobs.inspirededu.com — search is AJAX-loaded, so discovery reads sitemap.xml and keeps /job/<City>/<id>/ URLs whose city maps to IST cantons (TI/GR). seedUrls are stable location entry points, not per-job URLs (those 404 once a posting is filled). IST often has zero live TI/GR openings, in which case the crawler legitimately keeps existing data with no error.';
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

  for (const job of jobs) {
    if (!isIstJob(job)) continue;

    if (job.company !== IST_COMPANY_NAME) {
      job.company = IST_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== IST_KEY) {
      job.companyKey = IST_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton) {
      job.canton = DEFAULT_CANTON;
      fixed++;
    }
    if (!job.location) {
      job.location = 'Lugano';
      fixed++;
    }
  }

  if (fixed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(`🔧 Post-processed ${fixed} IST jobs (fixed company/location/canton).`);
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
  const tiJobs = istJobs.filter(j => j.canton === 'TI').length;
  const grJobs = istJobs.filter(j => j.canton === 'GR').length;
  console.log(`  🏫 Total IST jobs: ${istJobs.length} (TI: ${tiJobs}, GR: ${grJobs})`);

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
    console.log('   The careers portal may have no TI/GR openings.');
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

main().catch((err) => exitCrawlerOnError(err, 'International School of Ticino'));

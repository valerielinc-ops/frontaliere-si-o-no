#!/usr/bin/env node
/**
 * Dedicated lastminute.com (Chiasso) crawler runner.
 *
 * Source:
 *   https://corporate.lastminute.com/careers/jobs/?search=&department=&location=chiasso&contract=
 *
 * This script:
 *   1. Reads lastminute careers listing pages for Chiasso.
 *   2. Extracts canonical detail URLs under /careers/jobs/job?id=...
 *   3. Updates adapter seed URLs + seedMetaByUrl.
 *   4. Runs shared crawler scoped to lastminute company key.
 *   5. Post-processes rows for canonical consistency + dedupe.
 *   6. Enforces locale coverage in strict mode.
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
  detectLang,
  deriveLocalizedSlug,
  normalize,
  normalizeKey,
  mergeLocaleTextMap,
} from './lib/dedicated-crawler-common.mjs';
import {
  extractSrIdFromUrl,
  fetchSmartRecruitersDetail,
  parseSmartRecruitersDetail,
  validateLastminuteDescription,
  buildLastminuteLocaleFallback,
} from './lib/lastminute-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const LASTMINUTE_KEY = 'lastminute-com';
const DEFAULT_CANTON = getCompanyDefaults(LASTMINUTE_KEY)?.canton || 'TI';
const LASTMINUTE_COMPANY_NAME = 'lastminute.com';
const LASTMINUTE_COMPANY_DOMAIN = 'lastminute.com';
const LASTMINUTE_CORP_HOST = 'corporate.lastminute.com';
const LASTMINUTE_SOURCE = {
  name: 'Chiasso',
  canton: DEFAULT_CANTON,
  listingUrl:
    'https://corporate.lastminute.com/careers/jobs/?search=&department=&location=chiasso&contract=',
};

const LASTMINUTE_LOCALES = ['it', 'en', 'de', 'fr'];
const LASTMINUTE_BAD_FOOTER_LOCATION_RE =
  /\b(?:rokin\s+92\s*-\s*96|1012\s*kz\s+amsterdam|amsterdam,\s*netherlands|amsterdam)\b/i;

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function slugifyLastminute(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .trim();
}

function toAbsoluteLastminuteUrl(rawUrl = '') {
  const value = decodeHtmlEntities(rawUrl);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  }
  const pathname = value.startsWith('/') ? value : `/${value}`;
  return `https://${LASTMINUTE_CORP_HOST}${pathname}`;
}

function extractLastminuteId(raw = '') {
  const txt = String(raw || '').trim();
  if (!txt) return '';
  const m = txt.match(/(\d{6,})/);
  return m ? m[1] : '';
}

function extractLastminuteIdFromUrl(rawUrl = '') {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const idFromQuery = extractLastminuteId(url.searchParams.get('id') || '');
    if (idFromQuery) return idFromQuery;
    const smart = url.pathname.match(/\/lastminutecom\/(\d{6,})(?:-|$)/i);
    return smart ? smart[1] : '';
  } catch {
    return '';
  }
}

function buildCorporateDetailUrl({ id = '', jobName = '' } = {}) {
  const normalizedId = extractLastminuteId(id);
  if (!normalizedId) return '';
  const url = new URL(`https://${LASTMINUTE_CORP_HOST}/careers/jobs/job`);
  url.searchParams.set('id', normalizedId);
  const cleanJobName = String(jobName || '').trim().replace(/\s+/g, ' ');
  if (cleanJobName) {
    url.searchParams.set('jobName', cleanJobName);
  }
  return url.href;
}

function canonicalizeLastminuteUrl(rawUrl = '', fallbackTitle = '') {
  const absolute = toAbsoluteLastminuteUrl(rawUrl);
  if (!absolute) return '';

  try {
    const url = new URL(absolute);
    const host = url.hostname.toLowerCase();

    if (host.endsWith(LASTMINUTE_CORP_HOST) && /\/careers\/jobs\/job\/?$/i.test(url.pathname)) {
      return buildCorporateDetailUrl({
        id: url.searchParams.get('id') || '',
        jobName: decodeHtmlEntities(url.searchParams.get('jobName') || fallbackTitle || ''),
      }) || absolute;
    }

    if (host === 'jobs.smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) {
      const m = url.pathname.match(/\/lastminutecom\/(\d{6,})(?:-([^/?#]+))?/i);
      if (!m) return absolute;
      const id = m[1] || '';
      const slug = decodeURIComponent(String(m[2] || ''))
        .replace(/[-_]+/g, ' ')
        .trim();
      const fallback = decodeHtmlEntities(fallbackTitle || '');
      return buildCorporateDetailUrl({ id, jobName: slug || fallback }) || absolute;
    }

    return absolute;
  } catch {
    return absolute;
  }
}

function isTrustedLastminuteDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('corporate.lastminute.com') ||
      host.endsWith('lastminute.com') ||
      host === 'jobs.smartrecruiters.com' ||
      host.endsWith('.smartrecruiters.com')
    );
  } catch {
    return false;
  }
}

function isLastminuteJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === LASTMINUTE_KEY ||
    key.includes('lastminute') ||
    company.includes('lastminute') ||
    host.endsWith('corporate.lastminute.com') ||
    host.endsWith('lastminute.com') ||
    host.endsWith('smartrecruiters.com')
  );
}

function parseJobLinksFromListingHtml(html = '') {
  const source = String(html || '');
  const hrefRe = /href=(["'])(.*?)\1/gi;
  const outByKey = new Map();
  let match = null;
  while ((match = hrefRe.exec(source)) !== null) {
    const rawHref = decodeHtmlEntities(match[2] || '');
    if (!rawHref || !rawHref.includes('/careers/jobs/job?')) continue;
    const canonical = canonicalizeLastminuteUrl(rawHref);
    if (!canonical) continue;
    const id = extractLastminuteIdFromUrl(canonical);
    const key = id ? `id:${id}` : `url:${canonical.toLowerCase()}`;
    if (!outByKey.has(key)) outByKey.set(key, canonical);
  }
  return [...outByKey.values()];
}

async function fetchListingPage(url, timeoutMs, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent,
      },
    });
    const html = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLastminuteJobDetailUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  const detailByKey = new Map();
  const seedMetaByUrl = {};
  const maxPages = 20;
  let consecutiveNoNewPages = 0;

  console.log('🔍 Fetching lastminute.com jobs from careers listing...');

  for (let page = 1; page <= maxPages; page += 1) {
    const pageUrl = new URL(LASTMINUTE_SOURCE.listingUrl);
    pageUrl.searchParams.set('page', String(page));

    console.log(`  📡 page ${page}: ${pageUrl.href}`);
    let html = '';
    try {
      html = await fetchListingPage(pageUrl.href, timeoutMs, userAgent);
    } catch (err) {
      console.warn(`    ⚠️ Fetch failed on page ${page}: ${err?.message || err}`);
      if (page === 1) throw err;
      break;
    }

    const links = parseJobLinksFromListingHtml(html);
    if (links.length === 0) {
      console.log('    ℹ️ No detail links found on this page, stopping pagination.');
      break;
    }

    let pageNew = 0;
    for (const link of links) {
      const canonical = canonicalizeLastminuteUrl(link);
      const id = extractLastminuteIdFromUrl(canonical);
      const key = id ? `id:${id}` : `url:${canonical.toLowerCase()}`;
      if (!detailByKey.has(key)) {
        detailByKey.set(key, canonical);
        pageNew += 1;
      }
    }

    console.log(`    📦 ${links.length} link(s), ${pageNew} new`);

    if (pageNew === 0) consecutiveNoNewPages += 1;
    else consecutiveNoNewPages = 0;

    if (consecutiveNoNewPages >= 1) {
      console.log('    ℹ️ Page produced no new jobs, stopping pagination.');
      break;
    }
  }

  const seedUrls = [...detailByKey.values()];
  for (const detailUrl of seedUrls) {
    seedMetaByUrl[detailUrl] = {
      location: 'Chiasso',
      canton: LASTMINUTE_SOURCE.canton,
      country: 'CH',
      company: LASTMINUTE_COMPANY_NAME,
      companyDomain: LASTMINUTE_COMPANY_DOMAIN,
    };
  }

  console.log(`✅ Found ${seedUrls.length} unique lastminute.com detail URL(s).`);
  return { seedUrls, seedMetaByUrl };
}

function updateLastminuteAdapter({ seedUrls, seedMetaByUrl }) {
  const adapterPath = path.resolve(ADAPTERS_DIR, `${LASTMINUTE_KEY}.json`);
  const fallbackSeeds = [LASTMINUTE_SOURCE.listingUrl];
  const nextSeedUrls = Array.isArray(seedUrls) && seedUrls.length > 0 ? seedUrls : fallbackSeeds;

  let current = {};
  if (fs.existsSync(adapterPath)) {
    try {
      current = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) || {};
    } catch {
      current = {};
    }
  }

  const next = {
    ...current,
    companyKey: LASTMINUTE_KEY,
    companyName: LASTMINUTE_COMPANY_NAME,
    companyHost: LASTMINUTE_CORP_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['generic_ats', 'html', 'jsonld'],
    seedUrls: nextSeedUrls,
    seedMetaByUrl,
    notes:
      'Dedicated lastminute.com crawler seeds from Chiasso listing pages and canonicalizes detail URLs under corporate.lastminute.com/careers/jobs/job?id=...',
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(adapterPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  console.log(`🧩 Adapter updated: ${adapterPath}`);
}

function scoreLastminuteCandidate(job) {
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const lang = detectLang(`${job?.title || ''} ${job?.description || ''}`, 'it');
  const descLen = String(job?.description || '').trim().length;
  const titleLen = String(job?.title || '').trim().length;

  let score = 0;
  if (host.endsWith('corporate.lastminute.com')) score += 20000;
  if (host.endsWith('smartrecruiters.com')) score += 12000;
  if (lang === 'it') score += 4000;
  else if (lang === 'en') score += 1500;
  else if (lang === 'de') score += 1100;
  else if (lang === 'fr') score += 900;
  score += Math.min(8000, descLen);
  score += Math.min(2000, titleLen * 20);
  if (job?.titleByLocale?.it) score += 500;
  if (job?.descriptionByLocale?.it) score += 500;
  if (job?.slugByLocale?.it) score += 500;
  return score;
}

function buildLastminuteDedupeKey(job) {
  const canonical = canonicalizeLastminuteUrl(job?.url || '', job?.title || '');
  const id = extractLastminuteIdFromUrl(canonical);
  if (id) return `id:${id}`;
  const urlKey = canonical ? `url:${canonical.toLowerCase()}` : '';
  if (urlKey) return urlKey;
  const slug = String(job?.slug || '').trim().toLowerCase();
  if (slug) return `slug:${slug}`;
  const title = normalize(job?.title || '');
  return `title:${title}`;
}

function ensureLocaleFields(job) {
  const title = String(job?.title || '').trim();
  const description = String(job?.description || '').trim();

  const titleByLocale = { ...(job?.titleByLocale || {}) };
  const descriptionByLocale = { ...(job?.descriptionByLocale || {}) };
  const slugByLocale = { ...(job?.slugByLocale || {}) };

  for (const locale of LASTMINUTE_LOCALES) {
    if (!String(titleByLocale[locale] || '').trim() && title) {
      titleByLocale[locale] = title;
    }
    if (!String(descriptionByLocale[locale] || '').trim() && description) {
      descriptionByLocale[locale] = description;
    }
    if (!String(slugByLocale[locale] || '').trim()) {
      const candidate = deriveLocalizedSlug(job, locale) || job?.slug || '';
      if (candidate) slugByLocale[locale] = candidate;
    }
  }

  return { titleByLocale, descriptionByLocale, slugByLocale };
}

export function extractLastminuteLocationFromContent(input = '') {
  const text = decodeHtmlEntities(String(input || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  const explicitPatterns = [
    /(?:^|\b)Location\s*[-:]\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,80}?)(?:,\s*Switzerland\b|\s+Switzerland\b)/i,
    /(?:^|\b)Location\s*[-:]\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,80}?)(?:,\s*Svizzera\b|\s+Svizzera\b)/i,
    /(?:^|\b)Working model\s*[-:]\s*hybrid from\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,80}?)(?=\b|[.,;]|$)/i,
    /(?:^|\b)hybrid from\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,80}?)(?=\b|[.,;]|$)/i,
    /(?:^|\b)Location:\s*([A-ZÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,80}?)(?:,\s*Switzerland\b|\s+Switzerland\b)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    const city = String(match?.[1] || '')
      .replace(/\b(?:contract|team|level|brand|department)\b.*$/i, '')
      .trim();
    if (city && !LASTMINUTE_BAD_FOOTER_LOCATION_RE.test(city)) {
      return city;
    }
  }

  return '';
}

export function inferLastminuteLocation(job) {
  const signals = [
    job?.location,
    job?.addressLocality,
    job?.description,
    job?.descriptionByLocale?.en,
    job?.descriptionByLocale?.it,
    job?.descriptionByLocale?.de,
    job?.descriptionByLocale?.fr,
  ];

  for (const signal of signals) {
    const extracted = extractLastminuteLocationFromContent(signal);
    if (extracted) return extracted;
  }

  const current = String(job?.location || '').trim();
  if (current && !LASTMINUTE_BAD_FOOTER_LOCATION_RE.test(current)) return current;
  return LASTMINUTE_SOURCE.name;
}

function inferLastminuteContract(job) {
  const text = decodeHtmlEntities(
    [
      job?.description,
      job?.descriptionByLocale?.en,
      job?.descriptionByLocale?.it,
      job?.descriptionByLocale?.de,
      job?.descriptionByLocale?.fr,
    ]
      .filter(Boolean)
      .join('\n')
  );
  if (/\b(?:contract|contratto)\s*[:\-]\s*full[\s-]?time\b/i.test(text)) return 'full-time';
  if (/\b(?:contract|contratto)\s*[:\-]\s*part[\s-]?time\b/i.test(text)) return 'part-time';
  const current = String(job?.contract || '').trim().toLowerCase();
  return current || 'full-time';
}

export function buildLastminuteSlug(title = '', location = '') {
  return slugifyLastminute([title, location].filter(Boolean).join(' '));
}

function refreshLastminuteSlugs(job, location) {
  const nextSlugByLocale = { ...(job?.slugByLocale || {}) };
  for (const locale of LASTMINUTE_LOCALES) {
    const localizedTitle = String(job?.titleByLocale?.[locale] || job?.title || '').trim();
    const nextSlug = buildLastminuteSlug(localizedTitle, location);
    if (nextSlug) nextSlugByLocale[locale] = nextSlug;
  }
  const baseSlug = buildLastminuteSlug(job?.title || '', location) || String(job?.slug || '').trim();
  return { slug: baseSlug, slugByLocale: nextSlugByLocale };
}

export function normalizeLastminuteRow(job) {
  const canonicalUrl = canonicalizeLastminuteUrl(job?.url || '', job?.title || '');
  const localeFields = ensureLocaleFields(job);
  const location = inferLastminuteLocation({ ...job, ...localeFields });
  const refreshedSlugs = refreshLastminuteSlugs({ ...job, ...localeFields }, location);
  const contract = inferLastminuteContract({ ...job, ...localeFields });

  return {
    ...job,
    url: canonicalUrl || job?.url || '',
    company: LASTMINUTE_COMPANY_NAME,
    companyKey: LASTMINUTE_KEY,
    companyDomain: LASTMINUTE_COMPANY_DOMAIN,
    source: 'Company Careers Crawler',
    location,
    addressLocality: location,
    canton: String(job?.canton || '').trim() || DEFAULT_CANTON,
    country: String(job?.country || '').trim() || 'CH',
    contract,
    slug: refreshedSlugs.slug,
    ...localeFields,
    slugByLocale: refreshedSlugs.slugByLocale,
    sourceLang: detectLang((job?.description || '') + ' ' + (job?.title || ''), 'en'),
  };
}

function writeJobsFiles(jobs) {
  const payload = `${JSON.stringify(jobs, null, 2)}\n`;
  fs.writeFileSync(DATA_JOBS, payload, 'utf-8');
  fs.writeFileSync(PUBLIC_DATA_JOBS, payload, 'utf-8');
}

export function postProcessLastminuteJobs() {
  if (!fs.existsSync(DATA_JOBS)) return { total: 0, lastminute: 0, deduped: 0 };

  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return { total: 0, lastminute: 0, deduped: 0 };

  const bestByKey = new Map();
  for (const job of raw) {
    if (!isLastminuteJob(job)) continue;
    const normalizedRow = normalizeLastminuteRow(job);
    const dedupeKey = buildLastminuteDedupeKey(normalizedRow);
    const current = bestByKey.get(dedupeKey);
    if (!current || scoreLastminuteCandidate(normalizedRow) > scoreLastminuteCandidate(current)) {
      bestByKey.set(dedupeKey, normalizedRow);
    }
  }

  const seen = new Set();
  const next = [];
  let lastminuteCount = 0;
  let droppedDuplicates = 0;

  for (const job of raw) {
    if (!isLastminuteJob(job)) {
      next.push(job);
      continue;
    }

    const normalizedRow = normalizeLastminuteRow(job);
    const dedupeKey = buildLastminuteDedupeKey(normalizedRow);
    if (seen.has(dedupeKey)) {
      droppedDuplicates += 1;
      continue;
    }
    seen.add(dedupeKey);
    const best = bestByKey.get(dedupeKey) || normalizedRow;
    next.push(best);
    lastminuteCount += 1;
  }

  writeJobsFiles(next);
  return {
    total: next.length,
    lastminute: lastminuteCount,
    deduped: droppedDuplicates,
  };
}

function loadLastminuteJobs() {
  if (!fs.existsSync(DATA_JOBS)) return [];
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return [];
  return raw.filter(isLastminuteJob);
}

async function runDedicatedLastminuteCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: [LASTMINUTE_KEY],
    disableWorkdayForce: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

/**
 * Enrich jobs with full content from SmartRecruiters API.
 * This fetches the complete job description (all sections) directly
 * from the SR API, which the corporate website only loads via JS.
 */
async function enrichFromSmartRecruitersApi(seedUrls) {
  if (!fs.existsSync(DATA_JOBS)) return;
  const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(allJobs)) return;

  // Build a map of SR ID → seed URL for discovered jobs
  const srIdToUrl = new Map();
  for (const url of seedUrls) {
    const id = extractSrIdFromUrl(url);
    if (id) srIdToUrl.set(id, url);
  }

  // Also check existing lastminute jobs that may need enrichment
  for (const job of allJobs) {
    if (!isLastminuteJob(job)) continue;
    const id = extractSrIdFromUrl(job.url);
    if (id && !srIdToUrl.has(id)) srIdToUrl.set(id, job.url);
  }

  console.log(`\n📡 Enriching ${srIdToUrl.size} lastminute.com jobs from SmartRecruiters API...`);
  let enriched = 0;

  for (const [srId, corpUrl] of srIdToUrl) {
    const apiData = await fetchSmartRecruitersDetail(srId);
    if (!apiData) continue;

    const detail = parseSmartRecruitersDetail(apiData);
    const validation = validateLastminuteDescription(detail);
    if (!validation.ok) {
      for (const w of validation.warnings) {
        console.warn(`  ⚠️ "${detail.title}": ${w}`);
      }
    }

    if (!detail.description || detail.description.length < 100) {
      console.warn(`  ⚠️ Skipping "${detail.title}" — SR API returned thin content`);
      continue;
    }

    // Find the matching job in data/jobs.json
    const existing = allJobs.find((j) => {
      if (!isLastminuteJob(j)) return false;
      const jId = extractSrIdFromUrl(j.url);
      return jId === srId;
    });

    if (existing) {
      // Only replace if SR API content is richer
      if (detail.description.length > (existing.description || '').length * 0.8) {
        existing.description = detail.description;
        existing.requirements = Array.isArray(detail.requirements) ? detail.requirements : [];
        existing.descriptionByLocale = mergeLocaleTextMap(
          existing.descriptionByLocale,
          { en: detail.description },
          30,
        );
        // Mark for re-translation so AI refreshes IT/DE/FR from the richer English
        existing.needsRetranslation = true;
        existing.title = detail.title || existing.title;
        if (detail.applyUrl) existing.applyUrl = detail.applyUrl;
        existing.location = detail.location || existing.location || 'Chiasso';
        existing.canton = detail.canton || existing.canton || DEFAULT_CANTON;
        enriched++;
        console.log(`  ✅ Enriched "${detail.title}" (${detail.description.length} chars, ${detail.sectionCount} sections)`);
      }
    } else {
      // New job from SR API — build and add with locale boilerplate
      const location = detail.location || 'Chiasso';
      const slug = slugifyLastminute(`${detail.title} ${location}`);
      const fallbackOpts = { title: detail.title, location, enDescription: detail.description };
      allJobs.push({
        title: detail.title,
        slug,
        url: corpUrl,
        applyUrl: detail.applyUrl || corpUrl,
        company: LASTMINUTE_COMPANY_NAME,
        companyKey: LASTMINUTE_KEY,
        companyDomain: LASTMINUTE_COMPANY_DOMAIN,
        location,
        addressLocality: location,
        canton: detail.canton || DEFAULT_CANTON,
        country: detail.country || 'CH',
        source: 'Company Careers Crawler',
        description: buildLastminuteLocaleFallback(fallbackOpts, 'it') || detail.description,
        descriptionByLocale: {
          en: detail.description,
          it: buildLastminuteLocaleFallback(fallbackOpts, 'it'),
          de: buildLastminuteLocaleFallback(fallbackOpts, 'de'),
          fr: buildLastminuteLocaleFallback(fallbackOpts, 'fr'),
        },
        titleByLocale: { en: detail.title },
        slugByLocale: { en: slug },
        sourceLang: detectLang(detail.description || detail.title, 'en'),
        category: 'tech',
        sector: 'Tecnologia & IT',
        postedDate: detail.postedDate,
        employmentType: 'full-time',
        contractType: 'full-time',
      });
      enriched++;
      console.log(`  ✅ Added new "${detail.title}" (${detail.description.length} chars)`);
    }
  }

  if (enriched > 0) {
    writeJobsFiles(allJobs);
    console.log(`📦 SR API enrichment: ${enriched} job(s) enriched.`);
  } else {
    console.log('ℹ️ No jobs needed SR API enrichment.');
  }
}

/**
 * Fill any lastminute.com jobs that still have missing locale descriptions
 * after AI translation. Uses locale-specific boilerplate wrapping the EN
 * content as a deterministic fallback.
 */
function fillMissingLastminuteDescriptions() {
  if (!fs.existsSync(DATA_JOBS)) return 0;
  const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(allJobs)) return 0;

  const MIN_DESC_CHARS = 120;
  const FALLBACK_LOCALES = ['it', 'de', 'fr'];
  let filled = 0;

  for (const job of allJobs) {
    if (!isLastminuteJob(job)) continue;
    if (!job.descriptionByLocale) job.descriptionByLocale = {};

    const enDesc = String(job.descriptionByLocale.en || job.description || '').trim();
    const title = String(job.title || '').trim();
    const location = String(job.location || 'Chiasso').trim();

    for (const locale of FALLBACK_LOCALES) {
      const current = String(job.descriptionByLocale[locale] || '').trim();
      if (current.length >= MIN_DESC_CHARS) continue;

      const fallback = buildLastminuteLocaleFallback(
        { title, location, enDescription: enDesc },
        locale,
      );
      if (fallback && fallback.length >= MIN_DESC_CHARS) {
        job.descriptionByLocale[locale] = fallback;
        if (locale === 'it' && (!job.description || job.description.length < MIN_DESC_CHARS)) {
          job.description = fallback;
        }
        filled++;
      }
    }
  }

  if (filled > 0) {
    writeJobsFiles(allJobs);
    console.log(`🛡️ Locale fallback: filled ${filled} missing description(s) with boilerplate.`);
  }
  return filled;
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(LASTMINUTE_KEY, 'lastminute.com');
  console.log('🚀 lastminute.com dedicated crawler start');
  const beforeSnapshot = snapshotJobSlugs(loadLastminuteJobs());

  const { seedUrls, seedMetaByUrl } = await fetchLastminuteJobDetailUrls();
  updateLastminuteAdapter({ seedUrls, seedMetaByUrl });

  // Phase 1: Enrich descriptions directly from SmartRecruiters API
  await enrichFromSmartRecruitersApi(seedUrls);

  // Phase 2: Run base crawler for AI localization (EN→IT/DE/FR translations)
  await runDedicatedLastminuteCrawler();
  const post = postProcessLastminuteJobs();
  console.log(
    `🧹 Post-process lastminute: ${post.lastminute} active, ${post.deduped} duplicate(s) removed.`
  );

  // Phase 3: Fill any remaining gaps with locale-specific boilerplate
  fillMissingLastminuteDescriptions();

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LASTMINUTE_STRICT',
    label: 'lastminute.com',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isLastminuteJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedLastminuteDomain,
    untrustedDomainReason: 'untrusted_lastminute_domain',
    failOnMissingJobsFile: true,
    failWhenNoJobs: false,
    noJobsMessage: 'No lastminute.com jobs found after crawl — company may have no Ticino openings.',
    maxToleratedMissingDescriptions: 3,
  });

  const afterSnapshot = snapshotJobSlugs(loadLastminuteJobs());
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'lastminute.com');
  writeCrawlChangeSummaryToGH(diff, 'lastminute.com');

  console.log('✅ lastminute.com dedicated crawler completed');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isLastminuteJob) : [];
  writeJobsCrawlerSlice(LASTMINUTE_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: LASTMINUTE_KEY,
    label: 'lastminute.com',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error(`❌ lastminute.com crawler failed: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}

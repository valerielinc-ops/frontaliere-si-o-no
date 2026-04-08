#!/usr/bin/env node
/**
 * Dedicated Ti.CH (Cantone Ticino administration) crawler runner.
 * Runs only Amministrazione cantonale TI jobs and enforces full locale
 * coverage for SEO-critical fields.
 *
 * The Canton Ticino administration publishes jobs on a Rexx Systems
 * recruitment portal (concorsi.ti.ch). The main www4.ti.ch page
 * embeds the portal via an iframe.
 *
 * This script:
 *   1. Fetches the listing page at https://www.concorsi.ti.ch/ which
 *      is server-side rendered with a plain HTML table of all open
 *      job postings.
 *   2. Extracts detail page URLs from the listing table rows.
 *   3. Optionally cross-checks with the Atom RSS feed for additional
 *      URLs as fallback.
 *   4. Sets those detail URLs as adapter seed URLs.
 *   5. Runs the base crawler which fetches each detail page and
 *      parses the HTML content (no JSON-LD — Rexx Systems does not
 *      include structured data).
 *
 * Listing URL:
 *   https://www.concorsi.ti.ch/
 *
 * Detail page URL pattern:
 *   https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid={ID}
 *   (Note: URL contains an apostrophe in the path segment)
 *
 * RSS/Atom feed:
 *   https://www.concorsi.ti.ch/rss_generator-rss0.php?unit=act&lang=it
 *
 * ATS: Rexx Systems (rexx-systems.com) — Portal7
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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, detectLang } from './lib/dedicated-crawler-common.mjs';
import { parseTichDetailPage, titleOverlap, MIN_TICH_DESC_LENGTH } from './lib/tich-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const TICH_KEY = 'amministrazione-cantonale-ti';
const HQ = getCompanyDefaults('tich');
const TICH_COMPANY_NAME = 'Amministrazione Cantonale Ticino';

/**
 * Rexx Systems portal URLs.
 */
const LISTING_URL = 'https://www.concorsi.ti.ch/';
const RSS_URL = 'https://www.concorsi.ti.ch/rss_generator-rss0.php?unit=act&lang=it';
const DETAIL_BASE = 'https://www.concorsi.ti.ch/';

/**
 * Regex to extract job detail hrefs from the listing HTML table.
 * Matches: href="offerte-d'impieghi.html?yid=4101&sid=..."  or similar
 * We capture the relative or absolute URL up to the closing quote.
 */
const JOB_DETAIL_HREF_RE = /href="([^"]*offerte-d[''']impieghi\.html\?yid=\d+[^"]*)"/gi;

/**
 * Regex to extract yid from RSS/Atom feed <link> elements.
 * Matches: <link href="https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4030"/>
 */
const RSS_YID_RE = /href="([^"]*offerte-d[''']impieghi\.html\?yid=(\d+)[^"]*)"/gi;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
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

const TICH_CITIES = [
  'Bellinzona',
  'Lugano',
  'Locarno',
  'Mendrisio',
  'Chiasso',
  'Biasca',
  'Airolo',
  'Faido',
  'Giubiasco',
  'Manno',
  'Cadro',
  'Gordola',
  'Muralto',
  'Camorino',
  'Rivera',
  'Losone',
  'Brissago',
  'Minusio',
  'Massagno',
  'Paradiso',
  'Viganello',
  'Pregassona',
  'Savosa',
  'Breganzona',
  'Comano',
  'Canobbio',
  'Stabio',
  'Balerna',
  'Vacallo',
];

const TICH_CITY_LOOKUP = new Map(TICH_CITIES.map((city) => [normalize(city), city]));
const TICH_CITY_RE = new RegExp(
  `\\b(${TICH_CITIES.map((city) => city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

function canonicalizeTichCity(raw = '') {
  const clean = normalize(raw);
  return TICH_CITY_LOOKUP.get(clean) || '';
}

function normalizeTichTitle(raw = '') {
  const clean = String(raw || '')
    .replace(/^offerta di lavoro\s+/i, '')
    .replace(/\s+jobportal$/i, '')
    .replace(/\s+presso\s+amministrazione\s+cantonale\s+ticino\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!clean) return '';
  if (/^\d+\/\d+$/.test(clean)) return '';
  return clean;
}

function extractTichLocation(...texts) {
  for (const value of texts) {
    const text = String(value || '').trim();
    if (!text) continue;

    const cityAfterComma = text.match(/,\s*([A-ZÀ-Ü][A-Za-zÀ-ÖØ-öø-ÿ' -]{1,40})\s+presso\b/i);
    if (cityAfterComma) {
      const canonical = canonicalizeTichCity(cityAfterComma[1]);
      if (canonical) return canonical;
    }

    const cityDirect = text.match(TICH_CITY_RE)?.[1] || '';
    if (cityDirect) {
      const canonical = canonicalizeTichCity(cityDirect);
      if (canonical) return canonical;
    }
  }
  return 'Bellinzona';
}

/**
 * Match a job object as belonging to the Ti.CH crawl.
 */
function isTichJob(job) {
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
    key === TICH_KEY ||
    key.includes('amministrazione-cantonale-ti') ||
    host.includes('concorsi.ti.ch') ||
    host.includes('www4.ti.ch') ||
    (company.includes('amministrazione') && company.includes('cantonale') && company.includes('ti'))
  );
}

/**
 * Check whether a URL belongs to one of Ti.CH's trusted domains.
 */
function isTrustedTichDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host.endsWith('concorsi.ti.ch') ||
      host.endsWith('ti.ch')
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

function cleanTichDescription(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';

  text = text
    .replace(/^##\s*Descrizione\s*\n*/i, '')
    .replace(/(?:^|\n)Repubblica e Cantone Ticino(?:\s+Sezione delle risorse umane)?[^\n]*/gi, '')
    .replace(/(?:^|\n)##\s*Concorsi per la nomina[^\n]*/gi, '')
    .replace(/(?:^|\n)Foglio Ufficiale[^\n]*/gi, '')
    .replace(/(?:^|\n)##\s*Dipartimento[^\n]*/gi, '')
    .replace(/(?:^|\n)##\s*\d{1,3}\/\d{2}\s*$/gim, '')
    .replace(/\[candidatura online\s*»?\]\([^)]*\)/gi, '')
    .replace(/\bcandidatura online\s*»?/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const firstRealSection = text.match(/\n##\s*(Compiti|Mansioni|Requisiti|Profilo|Osservazioni|Condizioni|Scadenza|Contatto)\b/i);
  if (firstRealSection && firstRealSection.index > 0) {
    text = text.slice(firstRealSection.index + 1).trim();
  }

  return text;
}

function postProcessTichJobs() {
  if (!fs.existsSync(DATA_JOBS)) return 0;

  const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(allJobs)) return 0;

  let updated = 0;

  for (const job of allJobs) {
    if (!isTichJob(job)) continue;

    const before = JSON.stringify({
      company: job.company,
      companyKey: job.companyKey,
      companyDomain: job.companyDomain,
      canton: job.canton,
      title: job.title,
      location: job.location,
      locationByLocale: job.locationByLocale,
      description: job.description,
      descriptionByLocale: job.descriptionByLocale,
    });

    job.company = TICH_COMPANY_NAME;
    job.companyKey = TICH_KEY;
    job.companyDomain = 'concorsi.ti.ch';
    job.canton = HQ.canton;
    job.sourceLang = detectLang(job.description || job.title, 'it');

    const normalizedTitle = normalizeTichTitle(job.title || '');
    if (normalizedTitle) {
      job.title = normalizedTitle;
    }

    const location = extractTichLocation(
      job.location,
      job.title,
      job.description,
      job.descriptionByLocale?.it,
      job.descriptionByLocale?.de,
      job.descriptionByLocale?.en,
      job.descriptionByLocale?.fr,
      job.url,
    );
    job.location = location;
    if (job.locationByLocale && typeof job.locationByLocale === 'object') {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        job.locationByLocale[locale] = location;
      }
    }

    const cleaned = cleanTichDescription(job.description || '');
    if (cleaned.length >= 120) {
      job.description = cleaned;
    }

    if (job.descriptionByLocale && typeof job.descriptionByLocale === 'object') {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const localized = String(job.descriptionByLocale[locale] || '').trim();
        if (!localized) continue;
        const cleanedLocalized = cleanTichDescription(localized);
        if (cleanedLocalized.length >= 120) {
          job.descriptionByLocale[locale] = cleanedLocalized;
        }
      }
    }

    const after = JSON.stringify({
      company: job.company,
      companyKey: job.companyKey,
      companyDomain: job.companyDomain,
      canton: job.canton,
      title: job.title,
      location: job.location,
      locationByLocale: job.locationByLocale,
      description: job.description,
      descriptionByLocale: job.descriptionByLocale,
    });

    if (before !== after) updated += 1;
  }

  if (updated > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      fs.writeFileSync(PUBLIC_DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
    }
    console.log(`🧹 Post-process Ti.CH: aggiornati ${updated} job (company canonica + clean descrizione).`);
  }

  return updated;
}

/**
 * Normalize a detail URL extracted from the HTML.
 * Strips the session ID (&sid=...) to make URLs canonical,
 * and ensures the URL is absolute.
 */
function normalizeDetailUrl(rawUrl = '') {
  let url = String(rawUrl || '').trim();
  if (!url) return '';
  // Decode HTML entities — href attributes in HTML often encode & as &amp;
  // which prevents URL.searchParams from finding the 'sid' parameter correctly.
  url = url.replace(/&amp;/g, '&');
  // Make absolute if relative
  if (!url.startsWith('http')) {
    url = new URL(url, DETAIL_BASE).href;
  }
  // Strip the session ID parameter — it varies per request
  // and the page works fine without it
  try {
    const u = new URL(url);
    u.searchParams.delete('sid');
    return u.href;
  } catch {
    // Fallback: simple regex strip
    return url.replace(/[&?]sid=[^&]*/g, '').replace(/\?$/, '');
  }
}

// ──────────────────────────────────────────────────────────────
// Listing page fetching
// ──────────────────────────────────────────────────────────────

/**
 * Fetch Ti.CH job detail URLs from the listing page and RSS feed.
 *
 * The listing page at concorsi.ti.ch is a plain SSR HTML table
 * rendered by the Rexx Systems portal. All active jobs are listed
 * on a single page (no pagination needed).
 *
 * As a fallback, the Atom RSS feed is also parsed for additional URLs.
 *
 * Returns an array of absolute, canonical (no sid) detail URLs.
 */
async function fetchTichJobDetailUrls() {
  const allUrls = new Set();
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12_000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  // ── Step 1: Fetch the main listing page ──
  console.log(`🔍 Fetching Ti.CH listing page: ${LISTING_URL}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(LISTING_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': userAgent,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ Listing returned ${res.status} — will try RSS fallback.`);
    } else {
      const html = await res.text();

      // Extract all job detail href paths from the table
      let match;
      while ((match = JOB_DETAIL_HREF_RE.exec(html)) !== null) {
        const normalized = normalizeDetailUrl(match[1]);
        if (normalized) allUrls.add(normalized);
      }
      JOB_DETAIL_HREF_RE.lastIndex = 0;

      console.log(`  📦 Listing page: ${allUrls.size} job URL(s) found`);
    }
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err.message} — will try RSS fallback.`);
  }

  // ── Step 2: Fetch the RSS/Atom feed as fallback/supplement ──
  console.log(`🔍 Fetching Ti.CH RSS feed: ${RSS_URL}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(RSS_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
        'User-Agent': userAgent,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`⚠️ RSS feed returned ${res.status} — skipping.`);
    } else {
      const xml = await res.text();
      const beforeCount = allUrls.size;

      // Extract URLs from <link href="..."> and <id>...</id> elements
      let match;
      while ((match = RSS_YID_RE.exec(xml)) !== null) {
        const normalized = normalizeDetailUrl(match[1]);
        if (normalized) allUrls.add(normalized);
      }
      RSS_YID_RE.lastIndex = 0;

      // Also try <id> elements that contain yid URLs
      const idRe = /<id>([^<]*offerte-d[''']impieghi\.html\?yid=\d+[^<]*)<\/id>/gi;
      while ((match = idRe.exec(xml)) !== null) {
        const normalized = normalizeDetailUrl(match[1]);
        if (normalized) allUrls.add(normalized);
      }

      const newFromRss = allUrls.size - beforeCount;
      console.log(`  📦 RSS feed: ${newFromRss} additional URL(s) found`);
    }
  } catch (err) {
    console.warn(`⚠️ RSS feed fetch failed: ${err.message}`);
  }

  console.log(`✅ Total unique Ti.CH detail URLs discovered: ${allUrls.size}`);
  return [...allUrls];
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the Ti.CH adapter JSON has the correct seed URLs
 * (detail page URLs discovered from the listing page + RSS).
 */
function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${TICH_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${TICH_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: TICH_KEY,
      companyName: 'Amministrazione cantonale TI',
      companyHost: 'concorsi.ti.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html'],
      seedUrls,
      notes:
        'Rexx Systems ATS portal — detail URLs scraped from listing page and Atom RSS feed, each page has rich HTML content.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.companyHost = 'concorsi.ti.ch';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    // Remove jsonld mode since Rexx Systems does not include structured data
    adapter.crawlerModes = adapter.crawlerModes.filter((m) => m !== 'jsonld');
    if (!adapter.crawlerModes.includes('html')) adapter.crawlerModes.push('html');
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes =
      'Rexx Systems ATS portal — detail URLs scraped from listing page and Atom RSS feed, each page has rich HTML content.';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${TICH_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: TICH_KEY,
    localizeOnlyCompanyKeys: TICH_KEY,
    forceLocalizeKeys: TICH_KEY,
    disableWorkdayForce: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logTichJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const tichJobs = allJobs.filter(isTichJob);
  const ticinoJobs = tichJobs.filter((job) => normalize(job?.canton) === 'ti');
  const otherJobs = tichJobs.length - ticinoJobs.length;

  console.log(`\n📊 === Amministrazione cantonale TI Job Stats ===`);
  console.log(`  🏛️ Job totali trovati (Ti.CH): ${tichJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job senza cantone assegnato: ${otherJobs}`);
    const examples = tichJobs
      .filter((job) => normalize(job?.canton) !== 'ti')
      .map(
        (job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`,
      )
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(tichJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'TiCH');
  writeCrawlChangeSummaryToGH(crawlDiff, 'TiCH');

  return { total: tichJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateTichLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_TICH_STRICT',
    label: 'Ti.CH',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isTichJob,
    detectSourceLang: () => 'it', // Ti.CH jobs are always in Italian (Canton Ticino government)
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedTichDomain,
    untrustedDomainReason: 'untrusted_domain_for_tich_job',
    noJobsMessage: 'Nessun job Ti.CH trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Detail-page enrichment (FRO-70)
// ──────────────────────────────────────────────────────────────

async function fetchTichHtml(url, timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    if (!res.ok) { console.warn(`  ⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) {
    console.warn(`  ⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For each Ti.CH job whose title looks like an institutional portal heading
 * or whose description is too short, fetch the detail page and replace
 * title/description with the values extracted by parseTichDetailPage.
 *
 * Title guard  : titleOverlap(job.title, extractedTitle) < 0.4 → replace title
 * Body guards  : currentDesc.length < MIN_TICH_DESC_LENGTH
 *                OR currentDesc.length < 0.25 * sourceBodyLength → replace body
 */
async function enrichTichJobs() {
  if (!fs.existsSync(DATA_JOBS)) return 0;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let enriched = 0;

  for (const job of jobs) {
    if (!isTichJob(job)) continue;
    const detailUrl = String(job.url || '').trim();
    if (!detailUrl || !isTrustedTichDomain(detailUrl)) continue;

    const html = await fetchTichHtml(detailUrl);
    if (!html) continue;

    const { title: extractedTitle, body, sourceBodyLength } = parseTichDetailPage(html);

    let changed = false;

    // Title guard: replace if current title looks like institutional portal text
    if (extractedTitle && job.title) {
      const overlap = titleOverlap(job.title, extractedTitle);
      if (overlap < 0.4 && extractedTitle.length >= 10) {
        console.log(`  ✨ Ti.CH title fix: "${job.title}" → "${extractedTitle}"`);
        job.title = extractedTitle;
        changed = true;
      }
    } else if (extractedTitle && !job.title) {
      job.title = extractedTitle;
      changed = true;
    }

    // Body guard: enrich if description too short or less than 25% of source
    if (body && sourceBodyLength >= MIN_TICH_DESC_LENGTH) {
      const currentDesc = String(job.description || '').trim();
      const isTooShort = currentDesc.length < MIN_TICH_DESC_LENGTH;
      const isLessThanQuarter = currentDesc.length < 0.25 * sourceBodyLength;
      if (isTooShort || isLessThanQuarter) {
        console.log(`  ✨ Ti.CH body enrich "${job.slug}" (${currentDesc.length} → ${sourceBodyLength} chars)`);
        job.description = body;
        if (!job.descriptionByLocale) job.descriptionByLocale = {};
        if (!job.descriptionByLocale.it || body.length > String(job.descriptionByLocale.it || '').length) {
          job.descriptionByLocale.it = body;
        }
        changed = true;
      }
    }

    if (changed) enriched++;
  }

  if (enriched > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      fs.writeFileSync(PUBLIC_DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    }
    console.log(`✨ Enriched ${enriched} Ti.CH jobs with parsed detail-page content.`);
  }
  return enriched;
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(TICH_KEY, 'Ti.CH');
  console.log('🏛️ Running dedicated Ti.CH (Cantone Ticino) jobs crawler...');
  console.log('   Platform: Rexx Systems (concorsi.ti.ch)');
  console.log('   Source: Listing page + Atom RSS feed');
  console.log('');

  // Step 1: Fetch job detail URLs from listing page + RSS
  const detailUrls = await fetchTichJobDetailUrls();
  if (detailUrls.length === 0) {
    console.log(
      'ℹ️ Nessun URL di dettaglio Ti.CH trovato dalla listing. Uscita OK.',
    );
    return;
  }

  // Step 2: Update the adapter with the discovered detail URLs as seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(TICH_KEY, DATA_JOBS).filter(isTichJob))

  // Step 3: Run the base crawler which fetches each detail page
  // and parses the HTML content
  await runBaseCrawler();

  // Step 3b: normalize Ti.CH company + clean legacy noisy descriptions
  postProcessTichJobs();

  // Step 3c: enrich titles and descriptions by parsing the HTML detail pages (FRO-70)
  console.log('\n🔍 Checking Ti.CH jobs for title mismatches and truncated descriptions...');
  await enrichTichJobs();

  // Step 4: Log stats and validate
  const stats = logTichJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log(
      'ℹ️ Nessun job Ti.CH trovato in questa esecuzione. Nessun errore — uscita OK.',
    );
    return;
  }

  validateTichLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isTichJob) : [];
  writeJobsCrawlerSlice(TICH_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: TICH_KEY,
    label: 'Ti.CH',
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
  console.error(`❌ Ti.CH crawler failed: ${err?.message || err}`);
  process.exit(1);
});

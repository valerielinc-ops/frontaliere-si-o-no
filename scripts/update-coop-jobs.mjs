#!/usr/bin/env node
/**
 * Dedicated Coop (Coop Società Cooperativa) crawler runner.
 * Runs only Coop Ticino / Grigioni jobs and enforces full locale coverage
 * for SEO-critical fields.
 *
 * The Coop careers portal uses the Prospective.ch JobBooster platform.
 * The listing page at jobs.coopjobs.ch is a client-side SPA that cannot
 * be crawled directly. Instead, this script:
 *   1. Fetches the Prospective.ch JSON API to discover all Ticino and
 *      Grigioni job detail URLs.
 *   2. Sets those SSR detail URLs as adapter seed URLs.
 *   3. Runs the base crawler which fetches each detail page and parses
 *      the JSON-LD JobPosting structured data embedded in it.
 *
 * API endpoints used:
 *   - Jobs:       https://ohws.prospective.ch/public/v1/medium/1000103/jobs?lang=it&offset=0&limit=500&f=30:{cantonId}
 *   - Attributes: https://ohws.prospective.ch/public/v1/medium/1000103/attributes?lang=it
 *
 * Detail page URL pattern:
 *   https://jobs.coopjobs.ch/offene-stellen/{slug}/{uuid}
 *
 * The detail pages are fully SSR with schema.org/JobPosting JSON-LD,
 * so the base crawler's extractJsonLdBlocks() parses them correctly.
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
import {
  fetchCoopJsonLd,
  coopDescHtmlToMarkdown,
  validateCoopDescription,
  titleOverlap,
  applyCoopJsonLdToJob,
} from './lib/coop-job-parser.mjs';
import { detectLanguage } from './lib/detect-language.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const COOP_KEY = 'coop-ticino';

/**
 * Lightweight translation cache that persists Coop locale data across runs,
 * independently of STRICT validation success.
 *
 * Problem: when all 5 previous runs failed at validateCoopLocaleCoverage(),
 * the slice file was never written → no Coop jobs in data/jobs.json → the
 * shared-jobs-crawler contentReuse mechanism has nothing to reuse → all 177
 * jobs are AI-translated from scratch every run, exhausting free model quotas.
 *
 * Fix: save translations before validation. Next run injects them into
 * data/jobs.json so the merge step can preserve them for unchanged jobs.
 */
// Stored in by-crawler/ so it's automatically committed by git-commit-data.sh --slice-only.
const COOP_TRANSLATIONS_CACHE = path.resolve(ROOT, 'data', 'jobs', 'by-crawler', 'coop-ticino-locale-cache.json');

/**
 * Prospective.ch Career Center API for Coop.
 * Medium ID 1000103 = Coop's career center.
 *
 * Canton filter IDs (attribute 30):
 *   Ticino   = 1024522
 *   Grigioni = 1024512
 *
 * Position type filter IDs (attribute 50):
 *   Apprendistato (apprenticeship)  = 1024532
 *   Tirocinio di prova (trial)      = 1208595
 *
 * The website has 3 tabs:
 *   1. "Offerte di lavoro"       — regular job offers
 *   2. "Posti di apprendistato"  — apprenticeship positions
 *   3. "Tirocini di prova"       — trial internship positions
 *
 * We explicitly fetch each position category per canton to ensure
 * complete coverage across all 3 tabs.
 *
 * The API returns up to `limit` jobs per request.
 * We request both cantons and all position categories, then merge.
 */
const API_BASE = 'https://ohws.prospective.ch/public/v1/medium/1000103';
const CANTON_IDS = {
  TI: '1024522',
  GR: '1024512',
};

/**
 * Position type filter values (attribute 50 = "Posizione").
 * null means "no position filter" — catches any remaining types
 * (Quadro, Collaboratore, Partner in franchising, etc.)
 */
const POSITION_TYPES = {
  'Offerte di lavoro':      null,            // all regular jobs (no filter)
  'Posti di apprendistato': '1024532',       // Apprendistato
  'Tirocini di prova':      '1208595',       // Tirocinio di prova
};

const API_LIMIT = 500; // max jobs per request
const DISCOVERED_COOP_HOSTS = new Set();

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function hostOf(rawUrl = '') {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
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
  return detectLanguage(text, 'it');
}

/**
 * Match a job object as belonging to the Coop crawl.
 */
function isCoopJob(job) {
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
  // Word-boundary check: 'coop' the brand, not 'cooperativa' (which matches Migros)
  const hasCoopWord = /\bcoop\b/.test(company);
  return (
    key === COOP_KEY ||
    key.includes('coop-ticino') ||
    key.includes('coop-gruppo') ||
    host.includes('coopjobs.ch') ||
    host.includes('jobs.coop.ch') ||
    (hasCoopWord && (company.includes('ticino') || company.includes('genossenschaft')))
  );
}

/**
 * Check whether a URL belongs to one of Coop's trusted domains.
 */
function isTrustedCoopDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (DISCOVERED_COOP_HOSTS.has(host)) return true;
    return (
      host.endsWith('coopjobs.ch') ||
      host.endsWith('coop.ch') ||
      host.endsWith('fust.ch') ||       // Fust = Coop Group subsidiary
      host.includes('prospective.ch')
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

function normalizeCantonCode(raw = '', fallback = '') {
  const lower = String(raw || '').trim().toLowerCase();
  if (['ti', 'ticino', 'tessin'].includes(lower)) return 'TI';
  if (['gr', 'grigioni', 'graubunden', 'graubünden', 'grisons'].includes(lower)) return 'GR';
  return fallback || '';
}

function cantonLabel(canton = '') {
  return canton === 'GR' ? 'Grigioni' : 'Ticino';
}

function dateOnly(raw = '') {
  const dt = new Date(raw || Date.now());
  if (Number.isNaN(dt.getTime())) return new Date().toISOString().slice(0, 10);
  return dt.toISOString().slice(0, 10);
}

function buildSeedMetaFromApiJob(job, fallbackCanton) {
  const attr30 = String(job?.attributes?.['30']?.[0] || '').trim();
  const canton = normalizeCantonCode(attr30, fallbackCanton);
  // Try to get city-level location from various API fields before falling back to canton
  const apiCity = String(job?.location || job?.place || job?.city || job?.address?.city || '').trim();
  const location = apiCity || attr30 || cantonLabel(canton || fallbackCanton);
  const company = String(job?.attributes?.['70']?.[0] || job?.company || '').trim();
  const contract = String(job?.attributes?.['40']?.[0] || '').trim();
  return {
    location,
    canton: canton || fallbackCanton,
    ...(company ? { company } : {}),
    ...(contract ? { contract } : {}),
    ...(job?.date || job?.datePosted || job?.publishedAt || job?.published_at || job?.createdAt
      ? { postedDate: dateOnly(job?.date || job?.datePosted || job?.publishedAt || job?.published_at || job?.createdAt) }
      : {}),
  };
}

// ──────────────────────────────────────────────────────────────
// Prospective.ch API fetching
// ──────────────────────────────────────────────────────────────

/**
 * Fetch Coop job detail URLs from the Prospective.ch JSON API
 * for the specified cantons (Ticino + Grigioni) across all 3
 * position categories: regular offers, apprenticeships, and trials.
 *
 * Returns unique detail URLs + metadata indexed by URL.
 */
async function fetchCoopJobDetailUrls() {
  const allUrls = new Set();
  const seedMetaByUrl = {};
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

  /** Stats per category for logging. */
  const stats = {};

  for (const [canton, cantonId] of Object.entries(CANTON_IDS)) {
    for (const [category, positionId] of Object.entries(POSITION_TYPES)) {
      // Build API URL: always filter by canton, optionally by position type.
      // When positionId is null we get ALL positions for the canton (belt-and-suspenders).
      const params = new URLSearchParams({
        lang: 'it',
        offset: '0',
        limit: String(API_LIMIT),
      });
      // Canton filter (attribute 30)
      params.append('f', `30:${cantonId}`);
      // Position type filter (attribute 50), only when narrowing to a specific category
      if (positionId) {
        params.append('f', `50:${positionId}`);
      }

      const apiUrl = `${API_BASE}/jobs?${params}`;
      const label = `${canton}/${category}`;
      console.log(`🔍 Fetching Coop ${label} from API…`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(apiUrl, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
          },
        });
        clearTimeout(timer);

        if (!res.ok) {
          console.warn(`⚠️ API returned ${res.status} for ${label} — skipping.`);
          continue;
        }

        const data = await res.json();
        const jobs = data?.jobs || [];
        const total = data?.total ?? '?';
        stats[label] = { found: jobs.length, total };
        console.log(`  📦 ${label}: ${jobs.length} jobs (API total: ${total})`);

        for (const job of jobs) {
          const directLink = String(job?.links?.directlink || '').trim();
          if (directLink && directLink.startsWith('http')) {
            const discoveredHost = hostOf(directLink);
            if (discoveredHost) DISCOVERED_COOP_HOSTS.add(discoveredHost);
            allUrls.add(directLink);
            if (!seedMetaByUrl[directLink]) {
              seedMetaByUrl[directLink] = buildSeedMetaFromApiJob(job, canton);
            }
          }
        }
      } catch (err) {
        console.warn(`⚠️ API fetch failed for ${label}: ${err.message}`);
      }
    }
  }

  // Summary log
  console.log(`\n📋 Coop API Discovery Summary:`);
  for (const [label, s] of Object.entries(stats)) {
    console.log(`  ${label}: ${s.found} jobs (total ${s.total})`);
  }
  if (DISCOVERED_COOP_HOSTS.size > 0) {
    console.log(`  Trusted hosts from Coop API: ${[...DISCOVERED_COOP_HOSTS].sort().join(', ')}`);
  }
  console.log(`✅ Total unique Coop detail URLs discovered: ${allUrls.size}\n`);
  return { urls: [...allUrls], seedMetaByUrl };
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the Coop adapter JSON has the correct seed URLs
 * (detail page URLs discovered from the API).
 */
function ensureAdapterSeedUrls(seedUrls, seedMetaByUrl = {}) {
  const adapterPath = path.join(ADAPTERS_DIR, `${COOP_KEY}.json`);

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${COOP_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: COOP_KEY,
      companyName: 'Coop Ticino',
      companyHost: 'coopjobs.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      seedMetaByUrl,
      notes: 'Prospective.ch JobBooster platform — detail URLs from JSON API covering Offerte di lavoro + Posti di apprendistato + Tirocini di prova. Each page has JSON-LD JobPosting.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.seedMetaByUrl = seedMetaByUrl;
    adapter.companyHost = 'coopjobs.ch';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'Prospective.ch JobBooster platform — detail URLs from JSON API covering Offerte di lavoro + Posti di apprendistato + Tirocini di prova. Each page has JSON-LD JobPosting.';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${COOP_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

/**
 * Before the crawler runs, inject Coop jobs from the translation cache into
 * data/jobs.json. This allows shared-jobs-crawler's contentReuse mechanism to
 * preserve existing translations for unchanged jobs, avoiding a full 177/177
 * AI backfill on every run after a failed previous run.
 */
function injectCachedCoopTranslations() {
  if (!fs.existsSync(COOP_TRANSLATIONS_CACHE)) return;
  if (!fs.existsSync(DATA_JOBS)) return;

  let cache;
  try { cache = JSON.parse(fs.readFileSync(COOP_TRANSLATIONS_CACHE, 'utf-8')); } catch { return; }
  if (!Array.isArray(cache) || cache.length === 0) return;

  let allJobs;
  try { allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')); } catch { return; }
  if (!Array.isArray(allJobs)) return;

  const existingCoopCount = allJobs.filter(isCoopJob).length;
  if (existingCoopCount >= cache.length * 0.5) {
    // Dataset already has most Coop jobs — contentReuse will handle it naturally.
    return;
  }

  const existingUrls = new Set(allJobs.map((j) => j.url).filter(Boolean));
  const toInject = cache.filter((c) => c.url && !existingUrls.has(c.url));
  if (toInject.length === 0) return;

  allJobs.push(...toInject);
  fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
  console.log(`♻️  Translation cache: injected ${toInject.length}/${cache.length} Coop jobs into jobs.json for localization reuse`);
}

/**
 * After the crawler runs (but BEFORE STRICT validation), persist Coop
 * translations to a lightweight cache file. Even if validation fails and the
 * slice is never written, the next run can restore these translations and
 * avoid a full 177/177 AI backfill.
 */
function saveCoopTranslationsCache() {
  if (!fs.existsSync(DATA_JOBS)) return;
  let allJobs;
  try { allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')); } catch { return; }
  const coopJobs = Array.isArray(allJobs) ? allJobs.filter(isCoopJob) : [];
  if (coopJobs.length === 0) return;

  const cache = coopJobs.map((job) => ({
    url: job.url,
    slug: job.slug,
    title: job.title,
    company: job.company,
    companyKey: job.companyKey,
    location: job.location,
    canton: job.canton,
    description: job.description,
    requirements: job.requirements || [],
    titleByLocale: job.titleByLocale || {},
    descriptionByLocale: job.descriptionByLocale || {},
    requirementsByLocale: job.requirementsByLocale || {},
    slugByLocale: job.slugByLocale || {},
    postedDate: job.postedDate,
    crawledAt: job.crawledAt,
    source: job.source,
    sourceLang: job.sourceLang,
    cachedAt: new Date().toISOString(),
  }));

  try {
    // Directory is data/jobs/by-crawler/ which always exists after a crawler run.
    fs.mkdirSync(path.dirname(COOP_TRANSLATIONS_CACHE), { recursive: true });
    fs.writeFileSync(COOP_TRANSLATIONS_CACHE, JSON.stringify(cache, null, 2) + '\n');
    const LOCALES_CHECK = ['it', 'en', 'de', 'fr'];
    const fullyTranslated = cache.filter((c) =>
      LOCALES_CHECK.every((l) => (c.titleByLocale[l] || '').length >= 3 && (c.descriptionByLocale[l] || '').length >= 120)
    ).length;
    console.log(`💾 Translation cache saved: ${cache.length} Coop jobs (${fullyTranslated} fully translated, ${cache.length - fullyTranslated} partial)`);
  } catch (err) {
    console.warn(`⚠️  Failed to save Coop translation cache: ${err?.message || err}`);
  }
}

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COOP_KEY,
    localizeOnlyCompanyKeys: COOP_KEY,
    forceLocalizeKeys: COOP_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '260',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '260',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Post-processing: validate & repair Coop jobs against JSON-LD
// ──────────────────────────────────────────────────────────────

const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

async function postProcessCoopJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;

  const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const coopJobs = allJobs.filter(isCoopJob);
  if (coopJobs.length === 0) return;

  console.log(`\n🔧 Post-processing ${coopJobs.length} Coop jobs (title + description validation)…`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  let repaired = 0;

  for (const job of coopJobs) {
    const descLen = (job.description || '').length;
    const jsonLd = await fetchCoopJsonLd(job.url, timeoutMs);
    if (!jsonLd) continue;

    let changed = false;

    // ── Location & company update from JSON-LD ──
    const ldResult = applyCoopJsonLdToJob(job, jsonLd);
    if (ldResult.changed) {
      Object.assign(job, ldResult.job);
      changed = true;
    }

    // ── Title validation ──
    const ldTitle = (jsonLd.title || '').trim();
    if (ldTitle && job.title !== ldTitle) {
      const overlap = titleOverlap(job.title, ldTitle);
      if (overlap < 0.6) {
        const titleLang = detectLang(ldTitle);
        console.log(`  ⚠️ Title fix: "${job.title}" → "${ldTitle}" (overlap=${overlap.toFixed(2)}, lang=${titleLang})`);
        job.title = ldTitle;
        // Assign title to the correct locale based on detected language
        if (job.titleByLocale) {
          job.titleByLocale[titleLang] = ldTitle;
          // Don't copy German/French/English titles into IT locale
          if (titleLang !== 'it' && !job.titleByLocale.it) {
            // Leave IT empty — will be translated by localization pipeline
          }
        }
        changed = true;
      }
    }

    // ── Description validation ──
    const ldDesc = (jsonLd.description || '').trim();
    if (ldDesc) {
      const markdown = coopDescHtmlToMarkdown(ldDesc);
      const validation = validateCoopDescription(markdown, ldDesc.length);

      // Replace if: current is shorter than JSON-LD markdown, or current is too short
      if (markdown.length > descLen || descLen < 350) {
        if (markdown.length > 200) {
          // Build structured description with metadata
          const lines = [`## ${job.title || ldTitle}`, ''];
          // Add company from OG or hiringOrganization
          const company = jsonLd.hiringOrganization?.name || 'Coop';
          const locality = jsonLd.jobLocation?.address?.addressLocality || job.location || '';
          const region = jsonLd.jobLocation?.address?.addressRegion || '';
          if (locality) {
            lines.push(`**${company}** — ${locality}${region ? `, ${region}` : ''}, Svizzera`, '');
          }
          lines.push(markdown);
          // Footer
          const employment = jsonLd.employmentType === 'PART_TIME' ? 'Part-time' : 'Full-time';
          lines.push('', '---');
          lines.push(`**Tipo:** ${employment}`);
          if (locality) lines.push(`**Sede:** ${locality}`);

          const fullDesc = lines.join('\n');
          const prevLen = (job.description || '').length;
          job.description = fullDesc;
          // Detect source language and assign to the correct locale (FRO-309)
          const descLang = detectLang(fullDesc);
          if (job.descriptionByLocale && Math.abs(fullDesc.length - prevLen) > 100) {
            // Significant change — reset with correct locale assignment
            job.descriptionByLocale = { [descLang]: fullDesc };
          } else if (job.descriptionByLocale) {
            job.descriptionByLocale[descLang] = fullDesc;
          }
          // Update sourceLang to match detected language (FRO-309)
          if (descLang !== 'it') {
            job.sourceLang = descLang;
          }
          changed = true;
        }
      }

      if (!validation.ok) {
        for (const w of validation.warnings) {
          console.warn(`  ⚠️ ${(job.title || '').substring(0, 40)} — ${w}`);
        }
      }
    }

    if (changed) {
      repaired++;
    }

    // Throttle requests
    await new Promise((r) => setTimeout(r, 200));
  }

  if (repaired > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
    console.log(`  ✅ Repaired ${repaired}/${coopJobs.length} Coop jobs`);
  } else {
    console.log(`  ✅ All ${coopJobs.length} Coop jobs passed validation`);
  }
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logCoopJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const coopJobs = allJobs.filter(isCoopJob);
  const ticinoJobs = coopJobs.filter((job) => normalize(job?.canton) === 'ti');
  const grJobs = coopJobs.filter((job) => normalize(job?.canton) === 'gr');
  const otherJobs = coopJobs.length - ticinoJobs.length - grJobs.length;

  console.log(`\n📊 === Coop Ticino Job Stats ===`);
  console.log(`  🛒 Job totali trovati (Coop): ${coopJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  console.log(`  ✅ Job in Grigioni (canton=GR): ${grJobs.length}`);
  if (otherJobs > 0) {
    console.log(`  ℹ️ Job in altri cantoni: ${otherJobs}`);
    const examples = coopJobs
      .filter((job) => !['ti', 'gr'].includes(normalize(job?.canton)))
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(coopJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Coop');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Coop');

  return { total: coopJobs.length, ticino: ticinoJobs.length, coopJobs, crawlDiff };
}

function validateCoopLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_COOP_STRICT',
    label: 'Coop',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCoopJob,
    detectSourceLang: (text) => detectLang(text),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedCoopDomain,
    untrustedDomainReason: 'untrusted_domain_for_coop_job',
    noJobsMessage: 'Nessun job Coop trovato dopo il crawl — niente da validare.',
    maxToleratedMissingDescriptions: 12,
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime(); // reset wall-clock baseline at actual crawler start
  registerCrawlerSummaryGuard(COOP_KEY, 'Coop');
  console.log('   Platform: Prospective.ch JobBooster (Career Center 1000103)');
  console.log('   Cantons: TI (Ticino) + GR (Grigioni)');
  console.log('   Categories: Offerte di lavoro + Posti di apprendistato + Tirocini di prova');
  console.log('');

  // Step 1: Fetch job detail URLs from the Prospective.ch JSON API
  const discovery = await fetchCoopJobDetailUrls();
  const detailUrls = discovery.urls;
  if (detailUrls.length === 0) {
    console.log('ℹ️ Nessun URL di dettaglio Coop trovato dall\'API. Uscita OK.');
    return;
  }

  // Step 2: Update the adapter with the discovered detail URLs as seed URLs
  ensureAdapterSeedUrls(detailUrls, discovery.seedMetaByUrl);

  // Step 2b: Inject cached translations into jobs.json BEFORE the crawler runs.
  // When previous runs failed at validation, no slice was written → no Coop jobs
  // in jobs.json → shared-jobs-crawler re-translates all 177 from scratch.
  // Injecting the cache lets the merge step reuse existing translations via contentReuse.
  injectCachedCoopTranslations();

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COOP_KEY, DATA_JOBS).filter(isCoopJob))

  // Step 3: Run the base crawler which fetches each SSR detail page
  // and parses the JSON-LD JobPosting structured data
  await runBaseCrawler();

  // Step 3b: Post-process — validate titles and descriptions against JSON-LD
  await postProcessCoopJobs();

  // Step 3c: Persist translations to cache BEFORE STRICT validation.
  // Even if validateCoopLocaleCoverage() exits with code 1 below, the cache
  // preserves partial translations. Next run injects them back, reducing the
  // AI backfill from 177/177 → ~5-15/177 (only new or changed jobs).
  saveCoopTranslationsCache();

  // Step 4: Log stats and validate
  const stats = logCoopJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ Nessun job Coop trovato in questa esecuzione. Nessun errore — uscita OK.');
    return;
  }

  validateCoopLocaleCoverage();

  // Step 5: Write per-crawler slice and assemble global dataset
  if (stats.coopJobs && stats.coopJobs.length > 0) {
    writeJobsCrawlerSlice(COOP_KEY, stats.coopJobs);

    const durationMs = getCrawlerElapsedMs();
    const diff = stats.crawlDiff || { newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: [], unchangedCount: 0 };
    const summaryEntry = {
      key: COOP_KEY,
      label: 'Coop',
      generatedAt: new Date().toISOString(),
      total: stats.coopJobs.length,
      newCount: crawlDiff.newJobs.length,
      updatedCount: crawlDiff.updatedJobs.length,
      removedCount: crawlDiff.removedJobs.length,
      unchangedCount: crawlDiff.unchangedCount,
      durationMs,
      avgDurationMs: durationMs,
      durationHistory: [durationMs],
      newJobs: crawlDiff.newJobs.slice(0, 30),
      updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
      removedJobs: crawlDiff.removedJobs.slice(0, 30),
      unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
    };
    writeSummaryCrawlerSlice(summaryEntry);
    await assembleJobsDataset();
  }
}

main().catch((err) => {
  console.error(`❌ Coop crawler failed: ${err?.message || err}`);
  process.exit(1);
});

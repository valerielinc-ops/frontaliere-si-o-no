#!/usr/bin/env node
/**
 * Dedicated ALDI Suisse crawler runner.
 *
 * ALDI uses SAP SuccessFactors as their ATS, surfaced through a TYPO3 careers
 * portal at jobs.aldi.ch. The portal no longer server-renders `/job/{id}`
 * links — the job list is loaded client-side from the JSON REST endpoint
 * (`/rest/jobs/search`), and each detail page keeps the job-specific body in
 * `<div class="description">`.
 *
 * This crawler:
 *   1. Fetches the ALDI REST job-search API for job rows (url/city/zip/...)
 *   2. Fetches each detail page and parses the description/requirements body
 *   3. Merges parsed jobs into data/jobs.json
 *   4. Runs localization + validation
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  printPublishedJobUrls,
  writeJobsSummary,
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
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import {
  inferEmploymentType,
  parseAldiSearchResults,
  parseAldiDetailPage,
  ALDI_SEARCH_API,
} from './lib/aldi-suisse-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

/* -- Constants --------------------------------------------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ALDI_KEY = 'aldi-suisse';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(ALDI_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const ALDI_COMPANY_NAME = 'ALDI SUISSE';
const HQ = getCompanyDefaults(ALDI_KEY);
const ALDI_HOST = 'www.jobs.aldi.ch';

/** Ticino city → postal code map for ALDI store locations */
const TICINO_PLZ = {
  lugano: '6900', bellinzona: '6500', locarno: '6600', mendrisio: '6850',
  chiasso: '6830', biasca: '6710', giubiasco: '6512', agno: '6982',
  manno: '6928', rivera: '6802', camorino: '6528', tenero: '6598',
  losone: '6616', gordola: '6596', stabio: '6855', cadempino: '6814',
  vezia: '6943', lamone: '6814',
};

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function slugify(value = '') {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlugAtWordBoundary(slug, 180);
}

/* -- Matchers ---------------------------------------------------------- */
function isAldiJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === ALDI_KEY ||
    key.includes('aldi') ||
    company.includes('aldi') ||
    host === ALDI_HOST ||
    host.endsWith('aldi.ch') ||
    (host.includes('successfactors') && url.includes('aldisuis'))
  );
}

/* -- File I/O ---------------------------------------------------------- */
function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(ALDI_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((j) => !isAldiJob(j));
  const companyExisting = allJobs.filter((j) => isAldiJob(j));
  const byUrl = new Map();
  for (const job of parsedJobs) {
    const k = String(job?.url || '').trim().replace(/\/+$/, '');
    if (k) byUrl.set(k, job);
  }
  const deduped = [...byUrl.values()];
  const merged = mergePreserveLocaleData(companyExisting, deduped);
  const clean = merged.sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));
  writeJobsFiles([...others, ...clean]);
  return clean;
}

/* -- Discovery (REST API) --------------------------------------------- */
async function fetchAldiListings() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  console.log(`\ud83d\udd0d Fetching ALDI Suisse jobs: ${ALDI_SEARCH_API}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ALDI_SEARCH_API, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.warn(`\u26a0\ufe0f ALDI search API returned ${res.status}`);
      return [];
    }

    const json = await res.json();
    const listings = parseAldiSearchResults(json);
    console.log(`\u2705 Discovered ${listings.length} ALDI Suisse jobs`);
    return listings;
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch ALDI search API: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* -- Detail page fetching & parsing ------------------------------------ */
async function fetchAndParseDetailPages(listings) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const concurrency = Number(process.env.JOBS_CRAWLER_CONCURRENCY) || 3;
  const jobs = [];
  let droppedNoCanton = 0;

  for (let i = 0; i < listings.length; i += concurrency) {
    const batch = listings.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (listing) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(listing.url, {
            signal: controller.signal,
            headers: { Accept: 'text/html', 'User-Agent': UA },
            redirect: 'follow',
          });
          if (!res.ok) return null;
          const html = await res.text();
          return { listing, html };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      })
    );

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { listing, html } = r.value;

      const parsed = parseAldiDetailPage(html) || {};
      const rawTitle = listing.title || parsed.title || '';
      if (!rawTitle || rawTitle.length < 3) continue;

      // REST row holds the canonical structured fields; the detail page only
      // supplies the prose body + bullet requirements.
      let description = parsed.body || '';
      if (description.length > 8000) description = description.slice(0, 8000);
      const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
      const location = listing.city || parsed.location || '';
      const workPct = String(listing.workload || parsed.percentage || '').replace(/\s+/g, '');

      const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${rawTitle}-aldi-suisse`);
      // CH-only canton gate: ALDI Suisse hires across all 26 cantons, so an
      // unresolved location must NOT default to the HQ canton (TI/Lugano). A
      // row with an empty city (the REST `address` carries only the street, not
      // the locality) and a non-TI zip would otherwise be mislabeled Ticino —
      // landing on the wrong canton SEO page with inconsistent structured data
      // (addressRegion=TI paired with a non-TI postalCode). Drop it instead,
      // the same CH-only gate the Fust crawler uses (never defaulted to TI).
      const canton = inferAnyCanton(location);
      if (!canton) { droppedNoCanton += 1; continue; }
      const postalCode = listing.zip || TICINO_PLZ[location.toLowerCase()] || '';

      jobs.push({
        id: `aldi-suisse-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { it: jobSlug },
        company: ALDI_COMPANY_NAME,
        companyKey: ALDI_KEY,
        companyDomain: 'aldi.ch',
        title: rawTitle,
        titleByLocale: { it: rawTitle },
        description: description || `Posizione aperta presso ${ALDI_COMPANY_NAME}. ${rawTitle}.`,
        descriptionByLocale: { it: description || `Posizione aperta presso ${ALDI_COMPANY_NAME}. ${rawTitle}.` },
        requirements: requirements.slice(0, 20),
        requirementsByLocale: { it: requirements.slice(0, 20) },
        location,
        postalCode,
        canton,
        addressLocality: location || HQ.city,
        addressRegion: canton,
        addressCountry: 'CH',
        streetAddress: listing.address || 'Centro Monda 8',
        employmentType: inferEmploymentType(rawTitle, description, workPct || ''),
        category: 'retail',
        contract: 'full-time',
        workPercentage: workPct,
        currency: 'CHF',
        featured: false,
        postedDate: new Date().toISOString().slice(0, 10),
        url: listing.url,
        source: 'ALDI Suisse Dedicated Parser',
        sourceLang: detectLang(description || rawTitle, 'de'),
        crawledAt: new Date().toISOString(),
      });
    }
  }

  if (droppedNoCanton > 0) {
    console.log(`   ↪︎ Dropped ${droppedNoCanton} job(s) with an unresolvable canton (no TI default)`);
  }

  return jobs;
}

/* -- Main -------------------------------------------------------------- */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(ALDI_KEY, 'ALDI Suisse');
  console.log('\ud83d\uded2 Running dedicated ALDI Suisse jobs crawler...');
  console.log(`   Portal: ${ALDI_HOST}`);
  console.log('');

    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(ALDI_KEY, DATA_JOBS).filter(isAldiJob))

  const listings = await fetchAldiListings();
  if (listings.length === 0) {
    console.log('\u2139\ufe0f No ALDI Suisse jobs discovered. Exiting OK.');
    return;
  }

  console.log(`\ud83d\udd0d Fetching ${listings.length} detail pages...`);
  const parsedJobs = await fetchAndParseDetailPages(listings);
  console.log(`\ud83e\udde9 Parsed ${parsedJobs.length} ALDI Suisse jobs from detail pages.`);

  if (parsedJobs.length === 0) {
    console.log('\u26a0\ufe0f No ALDI jobs parsed from detail pages. Keeping existing.');
    return;
  }

  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'ALDI');
  writeJobsSummary(published, 'ALDI');

  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: ALDI_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_ALDI_SUISSE_STRICT',
    label: 'ALDI Suisse',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isAldiJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: 'No ALDI Suisse jobs found.',
    detectSourceLang: (t) => detectLang(t, 'de'),
    deriveSlug: deriveLocalizedSlug,
  });

  const finalJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const aldiJobs = Array.isArray(finalJobs) ? finalJobs.filter(isAldiJob) : [];

  console.log(`\n\ud83d\udcca === ALDI Suisse Job Stats ===`);
  console.log(`  \ud83d\uded2 Total ALDI Suisse jobs: ${aldiJobs.length}`);
  const afterSnapshot = snapshotJobSlugs(aldiJobs);
  const crawlDiff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'ALDI Suisse');
  writeCrawlChangeSummaryToGH(crawlDiff, 'ALDI Suisse');

  const dur = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(ALDI_KEY, aldiJobs);
  writeSummaryCrawlerSlice({
    key: ALDI_KEY,
    label: 'ALDI Suisse',
    generatedAt: new Date().toISOString(),
    total: aldiJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: dur,
    avgDurationMs: dur,
    durationHistory: [dur],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => exitCrawlerOnError(err, 'Aldi Suisse'));

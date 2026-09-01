#!/usr/bin/env node
/**
 * Dedicated Denner crawler runner.
 *
 * Denner is a subsidiary of Migros Group. Their jobs are listed on the
 * Migros Group portal at jobs.migros.ch under the Denner SA company filter.
 *
 * The Migros portal is a Nuxt.js SSR application. Listing pages contain
 * real <a href="..."> links. Detail pages have structured HTML sections
 * (overview, tasks, skills, benefits, recruitment) and JSON-LD.
 *
 * This crawler:
 *   1. Fetches Migros listing pages filtered for Denner + Ticino regions
 *   2. Extracts job detail URLs from the SSR HTML
 *   3. Fetches each detail page and parses title/description/location
 *   4. Merges parsed jobs into data/jobs.json
 *   5. Runs localization + validation
 */
import fs from 'node:fs';
import path from 'node:path';
import { exitCrawlerOnError, stripScriptsAndStyles } from './lib/crawler-template.mjs';
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
import { extractMigrosStructuredData } from './lib/migros-job-parser.mjs';
import { inferEmploymentType } from './lib/denner-job-parser.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { dedicatedMigrosOwner } from './lib/crawler-company-ownership.mjs';
import { launchChromium } from './lib/ensure-chromium.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';

/* -- Constants --------------------------------------------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DENNER_KEY = 'denner';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(DENNER_KEY);
const PUBLIC_DATA_JOBS = `${DATA_JOBS}.public.json`;
const DENNER_COMPANY_NAME = 'Denner';
const DENNER_HOST = 'jobs.migros.ch';
const DENNER_LISTING_BASE = 'https://jobs.migros.ch/it/le-nostre-imprese/denner-sa/posti-di-lavoro-vacanti';

/** Ticino city → postal code map (postalCode enrichment for Denner TI stores) */
const TICINO_PLZ = {
  lugano: '6900', bellinzona: '6500', locarno: '6600', mendrisio: '6850',
  chiasso: '6830', biasca: '6710', giubiasco: '6512', agno: '6982',
  manno: '6928', rivera: '6802', camorino: '6528', tenero: '6598',
  losone: '6616', gordola: '6596', minusio: '6648', massagno: '6900',
  pregassona: '6963', viganello: '6962', paradiso: '6900', stabio: '6855',
  balerna: '6828', novazzano: '6883', coldrerio: '6877', cadempino: '6814',
  vezia: '6943', lamone: '6814', morbio: '6834', 'morbio inferiore': '6834',
};

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const DENNER_JOB_PATH_RE = /\/job\/denner(?:-[^/]+)?\//i;

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
function isDennerJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === DENNER_KEY ||
    key.includes('denner') ||
    company.includes('denner') ||
    (host === DENNER_HOST && dedicatedMigrosOwner(job) === DENNER_KEY) ||
    url.includes('denner.ch')
  );
}

/* -- File I/O ---------------------------------------------------------- */
function writeJobsFiles(jobs) {
  writeJsonAtomic(DATA_JOBS, jobs);
  if (fs.existsSync(PUBLIC_DATA_JOBS)) writeJsonAtomic(PUBLIC_DATA_JOBS, jobs);
}

function mergeCompanyJobs(parsedJobs) {
  const existing = readExistingCrawlerJobs(DENNER_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? existing : [];
  const others = allJobs.filter((j) => !isDennerJob(j));
  const companyExisting = allJobs.filter((j) => isDennerJob(j));
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

/* -- Discovery --------------------------------------------------------- */
export async function fetchDennerJobUrls() {
  const allUrls = new Set();
  const headless = process.env.JOBS_DENNER_HEADLESS !== '0';
  const navTimeoutMs = Number(process.env.JOBS_DENNER_NAV_TIMEOUT_MS) || 30000;
  const paginationTimeoutMs = Number(process.env.JOBS_DENNER_PAGINATION_TIMEOUT_MS) || 2000;
  const paginationStallPolls = Math.max(1, Number(process.env.JOBS_DENNER_PAGINATION_STALL_POLLS) || 4);
  const maxPages = Number(process.env.JOBS_DENNER_MAX_PAGES) || 200;
  const browserChannel = String(process.env.JOBS_DENNER_BROWSER_CHANNEL || '').trim();
  const browser = await launchChromium({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ...(browserChannel ? { channel: browserChannel } : {}),
  });

  try {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    console.log(`\ud83d\udd0d Fetching nationwide Denner jobs: ${DENNER_LISTING_BASE}`);
    await page.goto(DENNER_LISTING_BASE, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });

    const consent = page
      .locator('button:has-text("Akzeptieren"), button:has-text("Alle akzeptieren"), button:has-text("Accept"), button:has-text("Accetta")')
      .first();
    if (await consent.isVisible().catch(() => false)) {
      await consent.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(3000);

    const collect = () => page.evaluate((pathSource) => {
      const pathPattern = new RegExp(pathSource, 'i');
      return [...new Set(
        [...document.querySelectorAll('a[href]')]
          .map((anchor) => anchor.getAttribute('href'))
          .filter((href) => href && pathPattern.test(href)),
      )];
    }, DENNER_JOB_PATH_RE.source);

    for (const href of await collect()) {
      allUrls.add(new URL(href, `https://${DENNER_HOST}`).toString());
    }
    let pageIndex = 1;
    while (pageIndex < maxPages) {
      const nextButton = page.locator([
        'button[aria-label*="ächste" i]',
        'button[aria-label*="successiva" i]',
        'button[aria-label*="suivante" i]',
        'button[aria-label*="next" i]',
        'button:has-text("Nächste Seite")',
        'button:has-text("Pagina successiva")',
      ].join(', ')).first();
      const visible = await nextButton.isVisible().catch(() => false);
      const disabled = await nextButton.isDisabled().catch(() => true);
      if (!visible || disabled) break;

      await nextButton.scrollIntoViewIfNeeded().catch(() => {});
      await nextButton.click();
      pageIndex += 1;
      const before = allUrls.size;
      for (let poll = 0; poll < paginationStallPolls; poll += 1) {
        await page.waitForTimeout(paginationTimeoutMs);
        for (const href of await collect()) {
          allUrls.add(new URL(href, `https://${DENNER_HOST}`).toString());
        }
        if (allUrls.size > before) break;
      }
      console.log(`  \ud83d\udce6 page ${pageIndex}: ${allUrls.size} total URL(s)`);
      if (allUrls.size === before) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\u2705 Total unique Denner detail URLs discovered: ${allUrls.size}`);
  return [...allUrls];
}

/* -- Detail page fetching & parsing ------------------------------------ */
async function fetchAndParseDetailPages(urls) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;
  const concurrency = Number(process.env.JOBS_CRAWLER_CONCURRENCY) || 3;
  const jobs = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'text/html', 'User-Agent': UA },
            redirect: 'follow',
          });
          if (!res.ok) return null;
          const html = await res.text();
          return { url, html };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      })
    );

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { url, html } = r.value;

      const migrosData = extractMigrosStructuredData(html);

      let jsonLd = null;
      const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
      if (jsonLdMatch) { try { jsonLd = JSON.parse(jsonLdMatch[1]); } catch {} }

      const h1Match = stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const rawTitle = jsonLd?.title || (h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '');
      if (!rawTitle) continue;

      const locMatch = html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i);
      const pcMatch = html.match(/postalCode['"]\s*:\s*['"](\d{4})/i);
      let location = locMatch ? locMatch[1].trim() : '';
      let postalCode = pcMatch ? pcMatch[1] : '';

      if (!location) {
        const metaLoc = rawTitle.match(/[-\u2013]\s*(\d{4})\s+([A-Z\u00C0-\u017E][a-z\u00e0-\u017e]+(?:\s+[A-Z\u00C0-\u017E][a-z\u00e0-\u017e]+)*)/);
        if (metaLoc) { postalCode = metaLoc[1]; location = metaLoc[2]; }
      }

      const description = migrosData?.description || jsonLd?.description || '';
      const pctMatch = rawTitle.match(/(\d+\s*-\s*\d+\s*%)/);
      const workPct = pctMatch ? pctMatch[1] : (migrosData?.workPercentage || '');

      const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${rawTitle}-denner`);

      jobs.push({
        id: `denner-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { it: jobSlug },
        company: DENNER_COMPANY_NAME,
        companyKey: DENNER_KEY,
        companyDomain: 'denner.ch',
        title: rawTitle.replace(/\s+/g, ' ').trim(),
        titleByLocale: { it: rawTitle.replace(/\s+/g, ' ').trim() },
        description: description || `Posizione aperta presso ${DENNER_COMPANY_NAME}. ${rawTitle}.`,
        descriptionByLocale: { it: description || `Posizione aperta presso ${DENNER_COMPANY_NAME}. ${rawTitle}.` },
        requirements: migrosData?.requirements || [],
        requirementsByLocale: { it: migrosData?.requirements || [] },
        location,
        postalCode: postalCode || TICINO_PLZ[location.toLowerCase()] || '',
        canton: inferAnyCanton(location) || '',
        addressLocality: location || '',
        addressRegion: inferAnyCanton(location) || '',
        addressCountry: 'CH',
        streetAddress: location ? `Denner ${location}` : 'Denner',
        employmentType: inferEmploymentType(rawTitle, description, workPct || ''),
        category: 'retail',
        contract: migrosData?.employmentType || 'full-time',
        workPercentage: workPct,
        currency: 'CHF',
        featured: false,
        postedDate: jsonLd?.datePosted || new Date().toISOString().slice(0, 10),
        url,
        source: 'Denner/Migros Dedicated Parser',
        sourceLang: detectLang(description || rawTitle, 'it'),
        crawledAt: new Date().toISOString(),
      });
    }
  }

  return jobs;
}

/* -- Main -------------------------------------------------------------- */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(DENNER_KEY, 'Denner');
  console.log('\ud83c\udfea Running dedicated Denner jobs crawler...');
  console.log(`   Portal: ${DENNER_HOST} (Migros Group portal)`);
  console.log('');

    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(DENNER_KEY, DATA_JOBS).filter(isDennerJob))

  const detailUrls = await fetchDennerJobUrls();
  if (detailUrls.length === 0) {
    console.log('\u2139\ufe0f No Denner job URLs discovered. Exiting OK.');
    return;
  }

  console.log(`\ud83d\udd0d Fetching ${detailUrls.length} detail pages...`);
  const parsedJobs = await fetchAndParseDetailPages(detailUrls);
  console.log(`\ud83e\udde9 Parsed ${parsedJobs.length} Denner jobs from detail pages.`);

  if (parsedJobs.length === 0) {
    console.log('\u26a0\ufe0f No Denner jobs parsed from detail pages. Keeping existing.');
    return;
  }

  const published = mergeCompanyJobs(parsedJobs);
  printPublishedJobUrls(published, 'Denner');
  writeJobsSummary(published, 'Denner');

  await runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: DENNER_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_DENNER_STRICT',
    label: 'Denner',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isDennerJob,
    failOnMissingJobsFile: true,
    failWhenNoJobs: true,
    noJobsMessage: 'No Denner jobs found.',
    detectSourceLang: (t) => detectLang(t, 'it'),
    deriveSlug: deriveLocalizedSlug,
  });

  const finalJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const dennerJobs = Array.isArray(finalJobs) ? finalJobs.filter(isDennerJob) : [];

  console.log(`\n\ud83d\udcca === Denner Job Stats ===`);
  console.log(`  \ud83c\udfea Total Denner jobs: ${dennerJobs.length}`);
  const afterSnapshot = snapshotJobSlugs(dennerJobs);
  const crawlDiff = computeCrawlDiff(_beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Denner');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Denner');

  const dur = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(DENNER_KEY, dennerJobs);
  writeSummaryCrawlerSlice({
    key: DENNER_KEY,
    label: 'Denner',
    generatedAt: new Date().toISOString(),
    total: dennerJobs.length,
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => exitCrawlerOnError(err, 'Denner'));
}

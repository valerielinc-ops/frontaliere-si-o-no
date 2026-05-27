#!/usr/bin/env node
/**
 * Dedicated ALDI Suisse crawler runner.
 *
 * ALDI uses SAP SuccessFactors as their ATS. Their careers portal is at
 * jobs.aldi.ch. The homepage contains direct job links at /job/{numericId}.
 * Each detail page is SSR HTML with full job descriptions.
 *
 * This crawler:
 *   1. Fetches the ALDI homepage and /it page for job detail URLs
 *   2. Fetches each detail page and parses title/description/location
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
import { inferEmploymentType } from './lib/aldi-suisse-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';

/* -- Constants --------------------------------------------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const ALDI_KEY = 'aldi-suisse';
const ALDI_COMPANY_NAME = 'ALDI SUISSE';
const HQ = getCompanyDefaults(ALDI_KEY);
const ALDI_HOST = 'www.jobs.aldi.ch';
const ALDI_BASE = 'https://www.jobs.aldi.ch';
const ALDI_LISTING_URLS = [
  'https://www.jobs.aldi.ch/',
  'https://www.jobs.aldi.ch/it',
];

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
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
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
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
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

/* -- Discovery --------------------------------------------------------- */
async function fetchAldiJobUrls() {
  const allUrls = new Set();
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;

  for (const listUrl of ALDI_LISTING_URLS) {
    console.log(`\ud83d\udd0d Fetching ALDI Suisse page: ${listUrl}`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(listUrl, {
        signal: controller.signal,
        headers: { Accept: 'text/html', 'User-Agent': UA },
      });
      clearTimeout(timer);

      if (!res.ok) { console.warn(`\u26a0\ufe0f ALDI page returned ${res.status} for ${listUrl}`); continue; }

      const html = await res.text();

      const jobIdPattern = /href="(\/job\/\d+)"/gi;
      let match;
      while ((match = jobIdPattern.exec(html)) !== null) {
        allUrls.add(`${ALDI_BASE}${match[1]}`);
      }

      const fullJobPattern = /href="(https?:\/\/[^"]*jobs\.aldi\.ch\/job\/\d+)"/gi;
      while ((match = fullJobPattern.exec(html)) !== null) {
        allUrls.add(match[1]);
      }
    } catch (err) {
      console.warn(`\u26a0\ufe0f Failed to fetch ALDI page ${listUrl}: ${err.message}`);
    }
  }

  console.log(`\u2705 Discovered ${allUrls.size} ALDI Suisse job URLs`);
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
          clearTimeout(timer);
          if (!res.ok) return null;
          const html = await res.text();
          return { url, html };
        } catch {
          clearTimeout(timer);
          return null;
        }
      })
    );

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { url, html } = r.value;

      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const rawTitle = h1Match ? stripHtml(h1Match[1]) : '';
      if (!rawTitle || rawTitle.length < 5) continue;

      let location = '';
      const locMatch = html.match(/(?:Standort|Sede|Location)\s*:?\s*([^<\n,]+)/i)
        || html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i);
      if (locMatch) location = locMatch[1].trim();

      let workPct = '';
      const pctMatch = rawTitle.match(/(\d+\s*(?:-\s*\d+)?\s*%)/);
      if (pctMatch) workPct = pctMatch[1].replace(/\s+/g, '');

      let description = '';
      const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
        || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      if (mainMatch) {
        description = stripHtml(mainMatch[1]);
        if (description.length > 8000) description = description.slice(0, 8000);
      }

      const requirements = [];
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      const mainHtml = mainMatch ? mainMatch[1] : html;
      while ((liMatch = liRe.exec(mainHtml)) !== null) {
        const text = stripHtml(liMatch[1]);
        if (text.length > 10 && text.length < 300) requirements.push(text);
      }

      const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${rawTitle}-aldi-suisse`);

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
        postalCode: TICINO_PLZ[location.toLowerCase()] || '6928',
        canton: inferAnyCanton(location) || HQ.canton,
        addressLocality: location || 'Manno',
        addressRegion: inferAnyCanton(location) || HQ.addressRegion,
        addressCountry: 'CH',
        streetAddress: 'Centro Monda 8',
        employmentType: inferEmploymentType(rawTitle, description, workPct || ''),
        category: 'retail',
        contract: 'full-time',
        workPercentage: workPct,
        currency: 'CHF',
        featured: false,
        postedDate: new Date().toISOString().slice(0, 10),
        url,
        source: 'ALDI Suisse Dedicated Parser',
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
  registerCrawlerSummaryGuard(ALDI_KEY, 'ALDI Suisse');
  console.log('\ud83d\uded2 Running dedicated ALDI Suisse jobs crawler...');
  console.log(`   Portal: ${ALDI_HOST}`);
  console.log('');

    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(ALDI_KEY, DATA_JOBS).filter(isAldiJob))

  const detailUrls = await fetchAldiJobUrls();
  if (detailUrls.length === 0) {
    console.log('\u2139\ufe0f No ALDI Suisse job URLs discovered. Exiting OK.');
    return;
  }

  console.log(`\ud83d\udd0d Fetching ${detailUrls.length} detail pages...`);
  const parsedJobs = await fetchAndParseDetailPages(detailUrls);
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

main().catch((err) => {
  console.error(`\u274c ALDI Suisse crawler failed: ${err?.message || err}`);
  process.exit(1);
});

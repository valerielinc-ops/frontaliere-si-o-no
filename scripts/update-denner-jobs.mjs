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
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

/* -- Constants --------------------------------------------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');

const DENNER_KEY = 'denner';
const DEFAULT_CANTON = getCompanyDefaults(DENNER_KEY)?.canton || 'TI';
const DENNER_COMPANY_NAME = 'Denner';
const DENNER_HOST = 'jobs.migros.ch';
const DENNER_LISTING_BASE = 'https://jobs.migros.ch/it/le-nostre-imprese/denner-sa/posti-di-lavoro-vacanti';
const REGION_IDS = { 'Svizzera meridionale': '871', Grigioni: '868' };

/** Ticino city → postal code map for Denner store locations */
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

const JOB_DETAIL_HREF_RE = /href="(\/(?:it|de|fr|en)\/(?:le-nostre-imprese|unsere-unternehmen|nos-entreprises|our-companies)\/job\/[^"]+)"/gi;

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
    (host === DENNER_HOST && url.includes('denner')) ||
    url.includes('denner.ch')
  );
}

/* -- File I/O ---------------------------------------------------------- */
function writeJobsFiles(jobs) {
  fs.writeFileSync(DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  if (fs.existsSync(PUBLIC_DATA_JOBS)) fs.writeFileSync(PUBLIC_DATA_JOBS, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
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
async function fetchDennerJobUrls() {
  const allUrls = new Set();
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 15000;

  const pagesToFetch = [
    ...Object.entries(REGION_IDS).map(([name, id]) => ({
      name,
      url: `${DENNER_LISTING_BASE}?REGION=${id}`,
    })),
    { name: 'All regions', url: DENNER_LISTING_BASE },
  ];

  for (const { name, url: listUrl } of pagesToFetch) {
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      const fetchUrl = page === 0 ? listUrl : `${listUrl}${listUrl.includes('?') ? '&' : '?'}page=${page}`;
      console.log(`\ud83d\udd0d Fetching Denner ${name} jobs (page ${page}): ${fetchUrl}`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(fetchUrl, {
          signal: controller.signal,
          headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA },
          redirect: 'follow',
        });
        clearTimeout(timer);

        if (!res.ok) { console.warn(`\u26a0\ufe0f Denner listing returned ${res.status} for ${name} page ${page}`); break; }

        const html = await res.text();
        const pageUrls = new Set();

        let match;
        while ((match = JOB_DETAIL_HREF_RE.exec(html)) !== null) {
          const relPath = match[1];
          if (!/denner/i.test(relPath)) continue;
          const fullUrl = `https://${DENNER_HOST}${relPath}`;
          if (!allUrls.has(fullUrl)) { pageUrls.add(fullUrl); allUrls.add(fullUrl); }
        }
        JOB_DETAIL_HREF_RE.lastIndex = 0;

        console.log(`  \ud83d\udce6 ${name} page ${page}: ${pageUrls.size} new URL(s)`);

        if (pageUrls.size === 0) { hasMore = false; }
        else {
          const nextExists = html.includes(`page=${page + 1}`);
          hasMore = nextExists;
          if (hasMore) page++;
        }
      } catch (err) {
        console.warn(`\u26a0\ufe0f Denner listing fetch failed for ${name} page ${page}: ${err.message}`);
        break;
      }
    }
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

      const migrosData = extractMigrosStructuredData(html);

      let jsonLd = null;
      const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
      if (jsonLdMatch) { try { jsonLd = JSON.parse(jsonLdMatch[1]); } catch {} }

      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
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
        postalCode: postalCode || TICINO_PLZ[location.toLowerCase()] || '6500',
        canton: TICINO_PLZ[location.toLowerCase()] ? 'TI' : (postalCode ? '' : DEFAULT_CANTON),
        addressLocality: location || 'Bellinzona',
        addressRegion: TICINO_PLZ[location.toLowerCase()] ? 'TI' : (postalCode ? '' : DEFAULT_CANTON),
        addressCountry: 'CH',
        streetAddress: location ? `Denner ${location}` : 'Denner Ticino',
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

main().catch((err) => {
  console.error(`\u274c Denner crawler failed: ${err?.message || err}`);
  process.exit(1);
});

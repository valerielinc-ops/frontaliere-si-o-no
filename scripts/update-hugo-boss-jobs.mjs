#!/usr/bin/env node
/**
 * Dedicated Hugo Boss (Coldrerio, TI) crawler runner.
 *
 * Hugo Boss uses the Phenom People platform at careers.hugoboss.com.
 * Job data is embedded in the phApp.ddo JavaScript object on the search
 * results page. We filter for Coldrerio/Ticino positions.
 *
 * Discovery flow:
 *   1. Fetch https://careers.hugoboss.com/global/en/search-results?keywords=&location=Coldrerio
 *   2. Extract phApp.ddo.eagerLoadRefineSearch.data.jobs
 *   3. Filter for Ticino/Coldrerio positions
 *   4. Build job objects with detail URLs
 *   5. Merge into data/jobs.json
 *   6. Run base crawler for AI localization
 *   7. Post-process and validate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { parseSearchPage, isHugoBossTargetLocation, buildDetailUrl, detectCategory, detectExperienceLevel, inferEmploymentType } from './lib/hugo-boss-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'hugo-boss';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Hugo Boss';
const COMPANY_HOST = 'careers.hugoboss.com';
const CAREERS_URL = 'https://careers.hugoboss.com/global/en/search-results?keywords=&location=Coldrerio';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(value = '') { return String(value || '').trim().toLowerCase(); }

function isCompanyJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('hugo-boss') || company.includes('hugo boss') || url.includes('hugoboss.com');
}

function isTrustedDomain(rawUrl = '') {
  try { return new URL(rawUrl).hostname.toLowerCase().includes('hugoboss.com'); } catch { return false; }
}

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,it-CH;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
}

function slugify(value = '') {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 90);
}

async function fetchJobs() {
  console.log(`🔍 Fetching Hugo Boss jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Hugo Boss careers page.'); return []; }
  console.log(`  📄 Page fetched (${html.length} chars)`);

  const allJobs = parseSearchPage(html);
  console.log(`  📋 Total jobs in DDO: ${allJobs.length}`);

  const ticinoJobs = allJobs.filter(isHugoBossTargetLocation);
  console.log(`  🎯 Ticino/Coldrerio jobs: ${ticinoJobs.length}`);

  return ticinoJobs.map((raw) => {
    const detailUrl = buildDetailUrl(raw);
    const slug = slugify(`${raw.title} hugo-boss coldrerio`);
    return {
      url: detailUrl || CAREERS_URL,
      applyUrl: raw.applyUrl ? `https://${COMPANY_HOST}${raw.applyUrl}` : detailUrl,
      title: raw.title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location: raw.city || 'Coldrerio',
      canton: DEFAULT_CANTON,
      country: 'CH',
      addressLocality: raw.city || 'Coldrerio',
      addressRegion: 'TI',
      addressCountry: 'CH',
      postalCode: '6862',
      streetAddress: 'Hugo Boss Ticino SA, Rancate/Coldrerio',
      description: raw.description || `${raw.title} position at Hugo Boss in Coldrerio, Ticino, Switzerland.`,
      titleByLocale: { en: raw.title },
      descriptionByLocale: { en: raw.description || '' },
      slug,
      slugByLocale: { en: slug, it: slug },
      category: detectCategory(raw.title),
      datePosted: raw.postedDate || new Date().toISOString().split('T')[0],
      source: 'hugo-boss-careers-crawler',
      sourceLang: detectLang(raw.description || raw.title, 'en'),
      employmentType: inferEmploymentType(raw.title, raw.description),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Moda / Lusso',
    };
  });
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isCompanyJob(j));
  const existingByUrl = new Map();
  for (const job of allJobs.filter(isCompanyJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const merged = [];
  let added = 0, updated = 0;
  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const old = existingByUrl.get(key);
    if (old) { merged.push({ ...old, ...discovered, titleByLocale: mergeLocaleTextMap(old.titleByLocale, discovered.titleByLocale, 3), descriptionByLocale: mergeLocaleTextMap(old.descriptionByLocale, discovered.descriptionByLocale, 30), slugByLocale: mergeLocaleTextMap(old.slugByLocale, discovered.slugByLocale, 3) }); updated++; }
    else { merged.push(discovered); added++; }
  }
  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`📦 Merge: ➕ ${added} added, 🔄 ${updated} updated, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const adapter = fs.existsSync(adapterPath) ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) : {};
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html', 'jsonld'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'Phenom People platform — jobs extracted from phApp.ddo in search results page.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Hugo Boss — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))

  const discovered = await fetchJobs();
  if (discovered.length === 0) { console.log('⚠️ No Hugo Boss jobs discovered. Keeping existing.'); return; }

  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);

  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });

  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_HUGO_BOSS_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_hugoboss_domain', failWhenNoJobs: false });

  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME);
  writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);

  const _durationMs = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Hugo Boss crawler complete.');
}

main().catch((err) => { console.error(`❌ Hugo Boss crawler failed: ${err?.message || err}`); process.exit(1); });

#!/usr/bin/env node
/**
 * Dedicated Sintetica SA (Mendrisio, TI) crawler runner.
 *
 * Sintetica uses the NCore Platform at:
 *   https://app.ncoreplat.com/jobboard/1255/sintetica
 * Detail pages at: /jobposition/{id}/{slug}/sintetica
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang } from './lib/dedicated-crawler-common.mjs';
import { parseListingPage, parseDetailPage, slugify, detectCategory, detectExperienceLevel, inferEmploymentType, MIN_DESC_LENGTH } from './lib/sintetica-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'sintetica';
const COMPANY_NAME = 'Sintetica SA';
const COMPANY_HOST = 'app.ncoreplat.com';
const CAREERS_URL = 'https://app.ncoreplat.com/jobboard/1255/sintetica';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }
function isCompanyJob(job) {
  const key = normalize(job?.companyKey || ''); const company = normalize(job?.company || ''); const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('sintetica') || company.includes('sintetica') || url.includes('sintetica');
}
function isTrustedDomain(rawUrl = '') { try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('ncoreplat.com') || h.includes('sintetica'); } catch { return false; } }

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,it-CH;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    clearTimeout(timer); if (!res.ok) { console.warn(`⚠️ HTTP ${res.status}`); return null; } return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
}

async function fetchJobs() {
  console.log(`🔍 Fetching Sintetica SA jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Sintetica careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 Jobs found: ${listings.length}`);
  if (!listings.length) return [];

  const jobs = [];
  for (const raw of listings) {
    const slug = slugify(raw.title, 'sintetica');
    const fallbackDesc = `${raw.title} — posizione aperta presso Sintetica SA a Mendrisio, Canton Ticino, Svizzera. Sintetica SA è un'azienda farmaceutica svizzera specializzata nella produzione di farmaci sterili iniettabili. Con sede a Mendrisio, l'azienda offre un ambiente di lavoro innovativo nel settore farmaceutico, con opportunità di crescita professionale nel cuore del Ticino.`;

    // Fetch detail page for full job description
    let description = raw.snippet || '';
    if (raw.url) {
      console.log(`    🔗 Fetching detail page: ${raw.url}`);
      const detailHtml = await fetchPage(raw.url);
      if (detailHtml) {
        const detail = parseDetailPage(detailHtml);
        if (detail.body && detail.body.length >= MIN_DESC_LENGTH) {
          description = `${raw.title} — Sintetica SA, Mendrisio (TI).\n\n${detail.body}`;
          console.log(`    ✅ Detail description: ${detail.body.length} chars`);
        } else {
          console.log(`    ⚠️ Detail page description too short (${(detail.body || '').length} chars), using fallback`);
        }
      } else {
        console.log(`    ⚠️ Could not fetch detail page, using fallback`);
      }
    }
    if (!description || description.length < MIN_DESC_LENGTH) {
      description = fallbackDesc;
    }

    jobs.push({
      url: raw.url, applyUrl: raw.url, title: raw.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: 'Mendrisio', canton: 'TI', country: 'CH',
      addressLocality: 'Mendrisio', addressRegion: 'TI', addressCountry: 'CH',
      postalCode: '6850', streetAddress: 'Via Penate 5',
      description,
      titleByLocale: { en: raw.title }, descriptionByLocale: {},
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(raw.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'sintetica-careers-crawler', employmentType: inferEmploymentType(raw.title, raw.snippet || ''),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Farmaceutica',
      _targetScope: { canton: 'TI', location: 'Mendrisio' },
      sourceLang: detectLang(description || raw.title, 'en'),
    });
  }
  return jobs;
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const nonCompanyJobs = (Array.isArray(existing) ? existing : []).filter((j) => !isCompanyJob(j));
  const existingByUrl = new Map();
  for (const job of (Array.isArray(existing) ? existing : []).filter(isCompanyJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const merged = []; let added = 0, updated = 0;
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url); const old = existingByUrl.get(key);
    if (old) { merged.push({
      ...old,
      ...d,
      titleByLocale: mergeLocaleTextMap(old.titleByLocale, d.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(old.descriptionByLocale, d.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(old.slugByLocale, d.slugByLocale, 3),
      previousSlugs: [...new Set([...(old.previousSlugs || []), ...(d.previousSlugs || [])])].slice(0, 20),
    }); updated++; }
    else { merged.push(d); added++; }
  }
  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`📦 Merge: ➕ ${added}, 🔄 ${updated}, 📊 ${final.length} total`);
}

function updateAdapterConfig(seedUrls) {
  const p = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const a = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'NCore Platform — Sintetica SA pharma jobs in Mendrisio, TI.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, COMPANY_NAME);
  console.log('═══════════════════════════════════════════════');
  console.log('  Sintetica SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Sintetica jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_SINTETICA_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_sintetica_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Sintetica SA crawler complete.');
}

main().catch((err) => { console.error(`❌ Sintetica crawler failed: ${err?.message || err}`); process.exit(1); });

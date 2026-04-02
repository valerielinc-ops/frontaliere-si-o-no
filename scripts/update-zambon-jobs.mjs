#!/usr/bin/env node
/**
 * Dedicated Zambon Svizzera SA (Cadempino, TI) crawler runner.
 *
 * Zambon's careers portal is at:
 *   https://www.zambon.com/en/open-positions
 *
 * The page uses NcorePlat ATS with a Vue.js frontend.
 * Job data is rendered client-side, so the HTML may contain only
 * Vue template placeholders when fetched server-side.
 *
 * Previously used jobopportunity.ch (defunct as of early 2026).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap } from './lib/dedicated-crawler-common.mjs';
import { parseListingPage, slugify, detectCategory, detectExperienceLevel, inferEmploymentType } from './lib/zambon-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'zambon';
const COMPANY_NAME = 'Zambon Svizzera SA';
const COMPANY_HOST = 'www.zambon.com';
const CAREERS_URL = 'https://www.zambon.com/en/open-positions';
const CAREERS_API = 'https://www.zambon.com/it/api/careers-api?visibility=external';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(v = '') { return String(v || '').trim().toLowerCase(); }
function isCompanyJob(job) {
  const key = normalize(job?.companyKey || ''); const company = normalize(job?.company || ''); const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.includes('zambon') || company.includes('zambon') || url.includes('zambon');
}
function isTrustedDomain(rawUrl = '') { try { const h = new URL(rawUrl).hostname.toLowerCase(); return h.includes('zambon') || h.includes('ncoreplat.com'); } catch { return false; } }

async function fetchPage(url, timeoutMs = 20000) {
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,it-CH;q=0.9', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' } });
    clearTimeout(timer); if (!res.ok) { console.warn(`⚠️ HTTP ${res.status}`); return null; } return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed: ${err.message}`); return null; }
}

async function fetchJobs() {
  // Primary: use the JSON API (Vue.js frontend loads from this)
  console.log(`🔍 Fetching Zambon jobs from API: ${CAREERS_API}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(CAREERS_API, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const allJobs = body.data || body;
    if (!Array.isArray(allJobs)) throw new Error('API response is not an array');

    // Filter to Switzerland only
    const swissJobs = allJobs.filter(j => j.country === 'CH' || (j.country_label || '').toLowerCase().includes('switz'));
    console.log(`  📋 API returned ${allJobs.length} total positions, ${swissJobs.length} in Switzerland`);

    return swissJobs.map((raw) => {
      const title = (raw.title || '').trim();
      const slug = slugify(title, 'zambon');
      const detailUrl = raw.web_url || `https://app.ncoreplat.com/jobposition/${raw.id}`;
      return {
        id: `zambon-${raw.id}`,
        url: detailUrl, applyUrl: detailUrl, title,
        company: COMPANY_NAME, companyKey: COMPANY_KEY,
        location: 'Cadempino', canton: 'TI', country: 'CH',
        addressLocality: 'Cadempino', addressRegion: 'TI', addressCountry: 'CH',
        postalCode: '6814', streetAddress: 'Via Industria 13',
        // Placeholder description — the shared crawler will fetch the real one from the detail page
        description: `${title} — posizione presso ${COMPANY_NAME} a Cadempino (TI). Zambon è un'azienda farmaceutica internazionale specializzata in malattie respiratorie e rare. Area: ${raw.job_family || 'General'}. Contratto: ${raw.contract_type_3 || 'Full Time'}.`,
        titleByLocale: { it: title }, descriptionByLocale: {},
        slug, slugByLocale: { it: slug },
        category: detectCategory(title),
        datePosted: raw.opening_date ? parseZambonDate(raw.opening_date) : new Date().toISOString().split('T')[0],
        source: 'zambon-ncoreplat-api',
        employmentType: inferEmploymentType(title, raw.contract_type_3 || ''),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Farmaceutica',
        department: raw.job_family || '',
        seniority: raw.seniority || '',
      };
    });
  } catch (err) {
    console.warn(`⚠️ API fetch failed: ${err.message} — falling back to HTML parsing`);
  }

  // Fallback: HTML parsing (unlikely to work for Vue.js rendered pages)
  console.log(`🔍 Fallback: Fetching Zambon jobs from ${CAREERS_URL}`);
  const html = await fetchPage(CAREERS_URL, 25000);
  if (!html) { console.error('❌ Failed to fetch Zambon careers page.'); return []; }
  const listings = parseListingPage(html);
  console.log(`  📋 HTML fallback found: ${listings.length} jobs`);

  return listings.map((raw) => {
    const slug = slugify(raw.title, 'zambon');
    return {
      url: raw.url, applyUrl: raw.url, title: raw.title,
      company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: raw.location || 'Cadempino', canton: 'TI', country: 'CH',
      addressLocality: 'Cadempino', addressRegion: 'TI', addressCountry: 'CH',
      postalCode: '6814', streetAddress: 'Via Industria 13',
      description: `${raw.title} — posizione presso ${COMPANY_NAME} a Cadempino (TI).`,
      titleByLocale: { en: raw.title }, descriptionByLocale: {},
      slug, slugByLocale: { en: slug, it: slug },
      category: detectCategory(raw.title),
      datePosted: new Date().toISOString().split('T')[0],
      source: 'zambon-careers-crawler', employmentType: inferEmploymentType(raw.title, raw.snippet || ''),
      experienceLevel: detectExperienceLevel(raw.title),
      sector: 'Farmaceutica',
    };
  });
}

/** Parse "27 Mar 2026" → "2026-03-27" */
function parseZambonDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch {}
  return new Date().toISOString().split('T')[0];
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
  Object.assign(a, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: COMPANY_HOST, enabled: true, priority: 10, crawlerModes: ['html'], seedUrls: seedUrls.length ? seedUrls : [CAREERS_URL], notes: 'zambon.com NcorePlat ATS — Zambon Svizzera SA pharma jobs in Cadempino, TI.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
}

async function main() {
  setCrawlerStartTime();
  console.log('═══════════════════════════════════════════════');
  console.log('  Zambon Svizzera SA — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');
    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isCompanyJob))
  const discovered = await fetchJobs();
  if (!discovered.length) { console.log('⚠️ No Zambon jobs discovered.'); return; }
  updateAdapterConfig(discovered.map((j) => j.url));
  await mergeJobs(discovered);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, disableWorkdayForce: true, localizeExistingOnly: true });
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_ZAMBON_STRICT', label: COMPANY_NAME, dataJobsPath: DATA_JOBS, isTargetJob: isCompanyJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_zambon_domain', failWhenNoJobs: false });
  const afterSnapshot = snapshotJobSlugs((readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob));
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, COMPANY_NAME); writeCrawlChangeSummaryToGH(diff, COMPANY_NAME);
  const _dur = getCrawlerElapsedMs();
  const _sliceJobs = (readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS)).filter(isCompanyJob);
  writeJobsCrawlerSlice(COMPANY_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: COMPANY_NAME, generatedAt: new Date().toISOString(), total: _sliceJobs.length, newCount: 0, updatedCount: 0, removedCount: 0, unchangedCount: _sliceJobs.length, durationMs: _dur, avgDurationMs: _dur, durationHistory: [_dur], newJobs: [], updatedJobs: [], removedJobs: [], unchangedJobs: _sliceJobs.slice(0, 30) });
  await assembleJobsDataset();
  console.log('\n✅ Zambon crawler complete.');
}

main().catch((err) => { console.error(`❌ Zambon crawler failed: ${err?.message || err}`); process.exit(1); });

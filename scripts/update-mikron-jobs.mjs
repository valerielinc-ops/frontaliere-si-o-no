#!/usr/bin/env node
/**
 * Dedicated Mikron Group crawler runner.
 *
 * Mikron Group is a Swiss industrial/precision manufacturing company
 * with the Machining division headquartered in Agno, Canton Ticino.
 *
 * Career page: https://www.mikron.com/en/group/our-people/join-us/jobs
 * Agno filter: ?location=Switzerland%2C+Agno
 * The page uses Drupal Views with AJAX filtering.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import { writeJobsCrawlerSlice, writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard, assembleJobsDataset, readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergeLocaleTextMap, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { parseMikronJobs, parseMikronJobDetail, slugify, normalizeSpace, htmlToText, MIKRON_AGNO_URL, MIKRON_HOST } from './lib/mikron-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'mikron';
const DEFAULT_CANTON = getCompanyDefaults(COMPANY_KEY)?.canton || 'TI';
const COMPANY_NAME = 'Mikron Group';
const LOCALES = ['it', 'en', 'de', 'fr'];

function normalize(value = '') { return String(value || '').trim().toLowerCase(); }

function isMikronJob(job) {
  const key = normalize(job?.companyKey || '').replace(/[^a-z0-9]+/g, '-');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  return key === COMPANY_KEY || key.startsWith('mikron') || company.includes('mikron') || url.includes('mikron.com');
}

function isTrustedDomain(rawUrl = '') {
  try { const host = new URL(rawUrl).hostname.toLowerCase(); return host === MIKRON_HOST || host.endsWith('.mikron.com'); }
  catch { return false; }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/engineer|developer|software|it\b|system|data|motion\s*control/i.test(t)) return 'technology';
  if (/produc|manufactur|operator|technic|cnc|machin/i.test(t)) return 'production';
  if (/qa|quality|validation|metrol/i.test(t)) return 'quality';
  if (/sales|commercial|marketing/i.test(t)) return 'sales';
  if (/account|financ|controller/i.test(t)) return 'finance';
  if (/hr|human|recruit|formateur/i.test(t)) return 'hr';
  if (/logistic|supply|warehouse|procurement/i.test(t)) return 'logistics';
  if (/manag|director|head|lead|chief/i.test(t)) return 'management';
  if (/apprenti|apprendist|lehrling|azubi/i.test(t)) return 'apprenticeship';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|entry|intern|stage|apprenti|apprendist|lehrling|dual/i.test(t)) return 'ENTRY';
  if (/senior|lead|head|director|manager|principal|chief/i.test(t)) return 'SENIOR';
  return 'MID';
}

async function fetchPage(url) {
  const timeoutMs = parseInt(process.env.JOBS_CRAWLER_TIMEOUT_MS || '20000', 10);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)', Accept: 'text/html', 'Accept-Language': 'en,it-CH;q=0.9' } });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
}

/**
 * Detect employmentType from title percentage (e.g. "80-100%" → PART_TIME if <100%).
 */
function detectEmploymentType(title = '') {
  const pctMatch = title.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || title.match(/\((\d{1,3})%\)/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    const minPct = parseInt(pctMatch[1], 10);
    if (maxPct < 100 || minPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Build a rich fallback description (>50 words) when detail page yields nothing.
 */
function buildFallbackDescription(title, division, locale = 'en') {
  if (locale === 'it') {
    return `Posizione aperta: ${title} presso Mikron Group ad Agno, Cantone Ticino, Svizzera.${division ? ` Divisione: ${division}.` : ''}\n\nMikron Group è un leader globale nella produzione di precisione e automazione, con sede a Bienne (Svizzera) e operazioni in tutto il mondo. La divisione Mikron Machining, con sede ad Agno (Ticino), è specializzata nella progettazione e produzione di sistemi di lavorazione ad alta precisione per l'industria automobilistica, medicale, elettronica e dell'orologeria. L'azienda offre un ambiente di lavoro dinamico, possibilità di crescita professionale, una cultura aziendale positiva con forte spirito di squadra, e una retribuzione competitiva con eccellenti prestazioni sociali.`;
  }
  return `Open position: ${title} at Mikron Group in Agno, Canton Ticino, Switzerland.${division ? ` Division: ${division}.` : ''}\n\nMikron Group is a global leader in precision manufacturing and automation, headquartered in Biel/Bienne (Switzerland) with operations worldwide. The Mikron Machining division, based in Agno (Ticino), specializes in the design and production of high-precision machining systems for the automotive, medical, electronics, and watchmaking industries. The company offers a dynamic working environment, career growth opportunities, a positive corporate culture with strong team spirit, and competitive compensation with excellent social benefits.`;
}

async function fetchMikronJobs() {
  console.log(`🔍 Fetching Mikron Group Agno jobs`);
  console.log(`   URL: ${MIKRON_AGNO_URL}`);

  const html = await fetchPage(MIKRON_AGNO_URL);
  if (!html) return [];

  const parsed = parseMikronJobs(html, { filterAgno: true });
  console.log(`  📋 Agno jobs parsed from page: ${parsed.length}`);

  const jobs = [];
  for (const p of parsed) {
    const title = p.title;
    const slug = slugify(title, 'mikron');

    // Fetch detail page for rich description
    let descEn = '';
    let descIt = '';
    if (p.url) {
      console.log(`    🔗 Fetching detail page: ${p.url}`);
      const detailHtml = await fetchPage(p.url);
      if (detailHtml) {
        const detail = parseMikronJobDetail(detailHtml);
        if (detail.description && detail.description.split(/\s+/).length >= 30) {
          descEn = detail.description;
          console.log(`    ✅ Detail description: ${descEn.split(/\s+/).length} words`);
        } else {
          console.log(`    ⚠️ Detail page description too short (${(detail.description || '').split(/\s+/).length} words), using fallback`);
        }
      } else {
        console.log(`    ⚠️ Could not fetch detail page, using fallback`);
      }
      // Small delay to be respectful to the server
      await new Promise((r) => setTimeout(r, 500));
    }

    // Fallback: build a rich description (>50 words) if detail page failed
    if (!descEn || descEn.split(/\s+/).length < 50) {
      descEn = buildFallbackDescription(title, p.division, 'en');
    }
    if (!descIt) {
      descIt = buildFallbackDescription(title, p.division, 'it');
    }

    const employmentType = detectEmploymentType(title);

    jobs.push({
      url: p.url, applyUrl: p.url, title, company: COMPANY_NAME, companyKey: COMPANY_KEY,
      location: 'Agno', canton: DEFAULT_CANTON, country: 'CH',
      postalCode: '6982', streetAddress: 'Via Ginnasio 17, 6982 Agno',
      description: descEn, descriptionByLocale: { en: descEn, it: descIt },
      titleByLocale: { en: title }, slug, slugByLocale: { en: slug, it: slugify(title, 'mikron') },
      sourceLang: detectLang(descEn || title, 'en'),
      category: detectCategory(title), datePosted: new Date().toISOString().split('T')[0],
      source: 'mikron-html-crawler', employmentType,
      experienceLevel: detectExperienceLevel(title), sector: 'Manifattura / Precision Manufacturing',
      _targetScope: { canton: DEFAULT_CANTON, location: 'Agno' },
    });
  }
  return jobs;
}

function canonicalizeUrl(url = '') { try { return new URL(url).href.replace(/\/$/, '').toLowerCase(); } catch { return normalize(url); } }
function filterEmpty(obj = {}) { if (!obj || typeof obj !== 'object') return {}; const out = {}; for (const [k, v] of Object.entries(obj)) { if (v && String(v).trim()) out[k] = v; } return out; }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isMikronJob(j));
  const existingByUrl = new Map();
  for (const job of allJobs.filter(isMikronJob)) existingByUrl.set(canonicalizeUrl(job.url), job);
  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) discoveredByUrl.set(canonicalizeUrl(job.url), job);

  let added = 0, updated = 0, removed = 0;
  const merged = [];
  for (const d of discoveredJobs) {
    const key = canonicalizeUrl(d.url);
    const ex = existingByUrl.get(key);
    if (ex) { merged.push({ ...ex, title: d.title || ex.title, company: COMPANY_NAME, companyKey: COMPANY_KEY, source: 'mikron-html-crawler', titleByLocale: mergeLocaleTextMap(ex.titleByLocale, d.titleByLocale, 3), descriptionByLocale: mergeLocaleTextMap(ex.descriptionByLocale, d.descriptionByLocale, 30), slugByLocale: mergeLocaleTextMap(ex.slugByLocale, d.slugByLocale, 3) }); updated++; }
    else { merged.push(d); added++; }
  }
  for (const [url] of existingByUrl) { if (!discoveredByUrl.has(url)) removed++; }

  const final = [...nonCompanyJobs, ...merged];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');
  console.log(`\n📦 Merge: ➕${added} 🔄${updated} 🗑️${removed} 📊${final.length}`);
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(COMPANY_KEY, 'Mikron');
  console.log('═══════════════════════════════════════════════');
  console.log('  Mikron Group — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════\n');

    const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isMikronJob))

  const discoveredJobs = await fetchMikronJobs();
  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Mikron Agno jobs discovered. Keeping existing.');
    const afterSnapshot = fs.existsSync(DATA_JOBS) ? snapshotJobSlugs((JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) || []).filter(isMikronJob)) : new Map();
    printCrawlChangeSummary(computeCrawlDiff(beforeSnapshot, afterSnapshot), 'Mikron');
    writeCrawlChangeSummaryToGH(computeCrawlDiff(beforeSnapshot, afterSnapshot), 'Mikron');
    return;
  }

  // Adapter
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);
  const adapter = fs.existsSync(adapterPath) ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) : {};
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: MIKRON_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['html'], seedUrls: [MIKRON_AGNO_URL], notes: 'Drupal Views page — filter Agno TI.', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');

  await mergeJobs(discoveredJobs);
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, localizeExistingOnly: true, extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '20', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '20' } });

  // Post-process
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let fixed = 0;
    for (const j of (Array.isArray(jobs) ? jobs : [])) { if (!isMikronJob(j)) continue; if (j.company !== COMPANY_NAME) { j.company = COMPANY_NAME; fixed++; } j.companyKey = COMPANY_KEY; j.country = 'CH'; if (!j.canton) { j.canton = DEFAULT_CANTON; fixed++; } if (!j.location) { j.location = 'Agno'; fixed++; } }
    if (fixed > 0) { fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n'); fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n'); }
  }

  const finalJobs = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const companyJobs = (Array.isArray(finalJobs) ? finalJobs : []).filter(isMikronJob);
  console.log(`\n📊 Mikron Agno jobs: ${companyJobs.length}`);
  const diff = computeCrawlDiff(beforeSnapshot, snapshotJobSlugs(companyJobs));
  printCrawlChangeSummary(diff, 'Mikron');
  writeCrawlChangeSummaryToGH(diff, 'Mikron');
  validateDedicatedLocaleCoverage({ strictEnvVar: 'JOBS_MIKRON_STRICT', label: 'Mikron', dataJobsPath: DATA_JOBS, isTargetJob: isMikronJob, locales: LOCALES, isTrustedDomain, untrustedDomainReason: 'url_not_mikron_domain', failWhenNoJobs: false, noJobsMessage: 'No Mikron Agno jobs found.' });
  console.log('\n✅ Mikron Group crawler complete.');

  const _durationMs = getCrawlerElapsedMs();
  writeJobsCrawlerSlice(COMPANY_KEY, companyJobs);
  writeSummaryCrawlerSlice({ key: COMPANY_KEY, label: 'Mikron', generatedAt: new Date().toISOString(), total: companyJobs.length, newCount: diff.newJobs.length, updatedCount: diff.updatedJobs.length, removedCount: diff.removedJobs.length, unchangedCount: diff.unchangedCount, durationMs: _durationMs, avgDurationMs: _durationMs, durationHistory: [_durationMs], newJobs: diff.newJobs.slice(0, 30), updatedJobs: diff.updatedJobs.slice(0, 30), removedJobs: diff.removedJobs.slice(0, 30), unchangedJobs: (diff.unchangedJobs || []).slice(0, 30) });
  await assembleJobsDataset();
}

main().catch((err) => { console.error(`❌ Mikron crawler failed: ${err?.message || err}`); process.exit(1); });

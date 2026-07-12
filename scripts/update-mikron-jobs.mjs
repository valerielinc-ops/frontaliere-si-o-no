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
import { runDedicatedBaseCrawler, validateDedicatedLocaleCoverage, mergePreserveLocaleData, detectLang,
} from './lib/dedicated-crawler-common.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { parseMikronJobs, parseMikronJobDetail, slugify, normalizeSpace, htmlToText, MIKRON_CAREERS_URL, MIKRON_HOST } from './lib/mikron-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'mikron';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)', Accept: 'text/html', 'Accept-Language': 'en,it-CH;q=0.9' } });
    if (!res.ok) { console.warn(`⚠️ HTTP ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) { console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`); return null; }
  finally { clearTimeout(timer); }
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

// Known Swiss site addresses, keyed by city. Other cities fall back to the
// PLZ/city enrichment downstream (street/postalCode left empty).
const MIKRON_SITE_ADDRESS = {
  agno:   { postalCode: '6982', streetAddress: 'Via Ginnasio 17, 6982 Agno' },
  boudry: { postalCode: '2017', streetAddress: 'Route du Vignoble 17, 2017 Boudry' },
};

/** Resolve {city, canton, postalCode, streetAddress} from a "Country, City" location.
 * A blank canton means non-Swiss/unresolved — the caller drops the job. When the
 * location string is empty, fall back to the Swiss division → site mapping
 * (Machining → Agno TI, Automation → Boudry NE; Tool is Rottweil DE → unresolved). */
function resolveMikronLocation(rawLocation = '', division = '') {
  const parts = String(rawLocation || '').split(',').map((s) => s.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || '');
  const canton = city ? inferAnyCanton(city) : '';
  if (canton) return { city, canton, ...(MIKRON_SITE_ADDRESS[city.toLowerCase()] || {}) };
  if (!city) {
    const d = String(division || '').toLowerCase();
    if (d.includes('machining')) return { city: 'Agno', canton: 'TI', ...MIKRON_SITE_ADDRESS.agno };
    if (d.includes('automation')) return { city: 'Boudry', canton: 'NE', ...MIKRON_SITE_ADDRESS.boudry };
  }
  return { city, canton: '' };
}

async function fetchMikronJobs() {
  console.log(`🔍 Fetching Mikron Group jobs (all Swiss sites)`);
  console.log(`   URL: ${MIKRON_CAREERS_URL}`);

  const html = await fetchPage(MIKRON_CAREERS_URL);
  if (!html) return [];

  const parsed = parseMikronJobs(html, { filterAgno: false });
  console.log(`  📋 jobs parsed from page: ${parsed.length}`);

  const jobs = [];
  for (const p of parsed) {
    const title = p.title;
    const slug = slugify(title, 'mikron');

    // Fetch detail page for rich description
    let descEn = '';
    let descIt = '';
    let rawLocation = p.location || '';
    if (p.url) {
      console.log(`    🔗 Fetching detail page: ${p.url}`);
      const detailHtml = await fetchPage(p.url);
      if (detailHtml) {
        const detail = parseMikronJobDetail(detailHtml);
        if (detail.location) rawLocation = detail.location;
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

    // Derive the real site/canton per-job (Agno TI vs Boudry NE vs …).
    // A blank canton = non-Swiss (USA/Germany) or unresolved → drop the job
    // instead of mislabeling it as the Agno HQ.
    const { city, canton, postalCode, streetAddress } = resolveMikronLocation(rawLocation, p.division);
    if (!canton) {
      console.log(`    ⏭️ Skipped non-Swiss/unresolved location: ${title} (${rawLocation || 'n/a'})`);
      continue;
    }
    const city0 = city;

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
      location: city0, canton, country: 'CH',
      ...(postalCode && { postalCode }),
      ...(streetAddress && { streetAddress }),
      description: descEn, descriptionByLocale: { en: descEn, it: descIt },
      titleByLocale: { en: title }, slug, slugByLocale: { en: slug, it: slugify(title, 'mikron') },
      sourceLang: detectLang(descEn || title, 'en'),
      category: detectCategory(title), datePosted: new Date().toISOString().split('T')[0],
      source: 'mikron-html-crawler', employmentType,
      experienceLevel: detectExperienceLevel(title), sector: 'Manifattura / Precision Manufacturing',
      _targetScope: { canton, location: city0 },
    });
  }
  return jobs;
}

function filterEmpty(obj = {}) { if (!obj || typeof obj !== 'object') return {}; const out = {}; for (const [k, v] of Object.entries(obj)) { if (v && String(v).trim()) out[k] = v; } return out; }

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];
  const nonCompanyJobs = allJobs.filter((j) => !isMikronJob(j));
  const existingMikronJobs = allJobs.filter(isMikronJob);

  const existingKeys = new Set(existingMikronJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const discoveredKeys = new Set(discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean));
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const merged = mergePreserveLocaleData(existingMikronJobs, discoveredJobs).map((job) => ({
    ...job, company: COMPANY_NAME, companyKey: COMPANY_KEY, source: 'mikron-html-crawler',
  }));

  const final = [...nonCompanyJobs, ...merged];
  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);
  console.log(`\n📦 Merge: ➕${added} 🔄${updated} 🗑️${removed} 📊${final.length}`);
  return { added, updated, removed, total: final.length };
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
  Object.assign(adapter, { companyKey: COMPANY_KEY, companyName: COMPANY_NAME, companyHost: MIKRON_HOST, enabled: true, priority: Math.max(adapter.priority || 0, 10), crawlerModes: ['html'], seedUrls: [MIKRON_CAREERS_URL], notes: 'Drupal Views page — national listing (all Swiss sites); canton derived per-job (Agno TI / Boudry NE).', updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');

  await mergeJobs(discoveredJobs);
  // The base crawler seeds the per-crawler slice from the fresh data/jobs.json
  // before localizing (see runDedicatedBaseCrawler), avoiding the stale-slice
  // collapse in slice-only mode.
  console.log('\n🌐 Running base crawler for AI localization...');
  await runDedicatedBaseCrawler({ root: ROOT, companyKeys: COMPANY_KEY, localizeOnlyCompanyKeys: COMPANY_KEY, forceLocalizeKeys: COMPANY_KEY, localizeExistingOnly: true, extraEnv: { JOBS_CRAWLER_MAX_JOB_LINKS: '100000', JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000' } });

  // Post-process
  if (fs.existsSync(DATA_JOBS)) {
    const jobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let fixed = 0;
    for (const j of (Array.isArray(jobs) ? jobs : [])) { if (!isMikronJob(j)) continue; if (j.company !== COMPANY_NAME) { j.company = COMPANY_NAME; fixed++; } j.companyKey = COMPANY_KEY; j.country = 'CH'; if (!j.canton) { j.canton = DEFAULT_CANTON; fixed++; } if (!j.location) { j.location = 'Agno'; fixed++; } }
    if (fixed > 0) { writeJsonAtomic(DATA_JOBS, jobs); writeJsonAtomic(PUBLIC_JOBS, jobs); }
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

main().catch((err) => exitCrawlerOnError(err, 'Mikron'));
